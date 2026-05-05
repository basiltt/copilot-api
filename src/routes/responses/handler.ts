import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type { ResponsesPayload } from "~/services/copilot/responses-translation"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkBurstLimit, checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import {
  requiresChatCompletionsApi,
  translateFromResponsesPayloadToCC,
  translateFromCCToResponsesResponse,
  translateFromCCStreamToResponsesEvents,
  createCCToResponsesStreamState,
} from "~/services/copilot/responses-translation"

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000

function createInactivityAbort(timeoutMs: number = INACTIVITY_TIMEOUT_MS) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      const error = new Error(
        `Upstream connection inactive for ${Math.round(timeoutMs / 1000)}s`,
      )
      error.name = "TimeoutError"
      controller.abort(error)
    }, timeoutMs)
  }

  schedule()

  return {
    signal: controller.signal,
    keepAlive: schedule,
    clear: () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<Record<string, unknown>>()
  consola.debug("Responses API request:", JSON.stringify(payload).slice(-400))

  const model = typeof payload.model === "string" ? payload.model : ""

  await checkBurstLimit(state, model)

  if (state.manualApprove) await awaitApproval()

  // Claude models don't support the Responses API — translate to Chat Completions
  if (requiresChatCompletionsApi(model)) {
    return handleClaudeViaCC(c, payload as unknown as ResponsesPayload)
  }

  if (!state.copilotToken) throw new Error("Copilot token not found")

  const input = payload.input as Array<Record<string, unknown>> | undefined
  const enableVision =
    Array.isArray(input)
    && input.some((item) => {
      const content = item.content
      return (
        Array.isArray(content)
        && content.some(
          (part: Record<string, unknown>) => part.type === "input_image",
        )
      )
    })

  const isAgentCall =
    Array.isArray(input)
    && input.some((item) => {
      const role = typeof item.role === "string" ? item.role : ""
      const type = typeof item.type === "string" ? item.type : ""
      return ["assistant", "function_call", "function_call_output"].includes(
        role || type,
      )
    })

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  // Drop tool_choice when no tools are present — the API rejects this combination
  if (payload.tool_choice !== undefined) {
    const tools = payload.tools as Array<unknown> | undefined
    if (!tools || tools.length === 0) {
      delete payload.tool_choice
    }
  }

  const inactivity = createInactivityAbort()

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: inactivity.signal,
    // @ts-expect-error — Bun-specific option
    timeout: false,
  })

  inactivity.keepAlive()

  if (!response.ok) {
    inactivity.clear()
    throw new HTTPError("Failed to create responses completion", response)
  }

  const isStreaming = payload.stream === true

  if (isStreaming) {
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of events(response)) {
          inactivity.keepAlive()
          if (!event.data) continue
          if (event.data === "[DONE]") {
            await stream.writeSSE({ data: "[DONE]" })
            break
          }
          await stream.writeSSE({
            event: event.event ?? undefined,
            data: event.data,
          })
        }
      } finally {
        inactivity.clear()
      }
    })
  }

  inactivity.clear()
  const data = await response.json()
  return c.json(data)
}

async function handleClaudeViaCC(c: Context, payload: ResponsesPayload) {
  const ccPayload = translateFromResponsesPayloadToCC(payload)
  const isStreaming = payload.stream === true

  consola.debug(
    `[responses→cc] Routing ${payload.model} through /chat/completions`,
  )

  const result = await createChatCompletions(ccPayload)

  if (isStreaming && Symbol.asyncIterator in Object(result)) {
    const streamState = createCCToResponsesStreamState()
    const responsesId = `resp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`

    return streamSSE(c, async (stream) => {
      const responseStub = {
        id: responsesId,
        object: "response",
        model: payload.model,
        status: "in_progress",
        output: [],
      }
      await stream.writeSSE({
        event: "response.created",
        data: JSON.stringify({
          type: "response.created",
          response: responseStub,
        }),
      })
      await stream.writeSSE({
        event: "response.in_progress",
        data: JSON.stringify({
          type: "response.in_progress",
          response: responseStub,
        }),
      })

      for await (const event of result as AsyncIterable<{
        data?: string
        event?: string
      }>) {
        const data = event.data ?? (event as Record<string, unknown>).data
        if (!data || data === "[DONE]") continue

        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(data as string) as Record<string, unknown>
        } catch {
          continue
        }

        const responsesEvents = translateFromCCStreamToResponsesEvents(
          parsed,
          streamState,
        )
        for (const evt of responsesEvents) {
          await stream.writeSSE({ event: evt.event, data: evt.data })
        }
      }
      await stream.writeSSE({ data: "[DONE]" })
    })
  }

  // Non-streaming
  const responsesId = `resp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
  const responsesResponse = translateFromCCToResponsesResponse(
    result as import("~/services/copilot/create-chat-completions").ChatCompletionResponse,
    responsesId,
  )
  return c.json(responsesResponse)
}
