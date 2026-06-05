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
    return handleViaCC(c, payload as unknown as ResponsesPayload)
  }

  if (!state.copilotToken) throw new Error("Copilot token not found")

  const inputArr = payload.input as Array<Record<string, unknown>> | undefined
  const enableVision =
    Array.isArray(inputArr)
    && inputArr.some((item) => {
      const content = item.content
      return (
        Array.isArray(content)
        && content.some(
          (part: Record<string, unknown>) => part.type === "input_image",
        )
      )
    })

  const isAgentCall =
    Array.isArray(inputArr)
    && inputArr.some((item) => {
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

  // Strip fields unsupported by the Copilot responses endpoint
  delete payload.store

  // Trim large input items to keep body under ~4MB (Copilot returns 413 otherwise)
  const preTrimSize = JSON.stringify(payload).length
  trimResponsesInput(payload)
  const postTrimSize = JSON.stringify(payload).length
  if (preTrimSize !== postTrimSize) {
    consola.info(
      `[responses] Trimmed payload: ${(preTrimSize / 1024 / 1024).toFixed(2)}MB → ${(postTrimSize / 1024 / 1024).toFixed(2)}MB`,
    )
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

async function handleViaCC(c: Context, payload: ResponsesPayload) {
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

const MAX_BODY_BYTES = 3_800_000 // ~3.8MB safety margin under the ~4MB 413 limit
const MAX_ITEM_BYTES = 40_000 // individual item content cap (~40KB)
const MAX_INSTRUCTIONS_BYTES = 100_000 // instructions field cap (~100KB)

function trimStringField(
  obj: Record<string, unknown>,
  field: string,
  max: number,
): void {
  const val = obj[field]
  if (typeof val !== "string" || val.length <= max) return
  const half = Math.floor(max / 2)
  obj[field] = val.slice(0, half) + "\n[...truncated...]\n" + val.slice(-half)
}

function asRecord(item: unknown): Record<string, unknown> | null {
  if (typeof item !== "object" || item === null) return null
  return item as Record<string, unknown>
}

// First pass: trim individual oversized items (all string fields)
function trimIndividualItems(input: Array<unknown>): void {
  for (const item of input) {
    const obj = asRecord(item)
    if (!obj) continue
    trimStringField(obj, "content", MAX_ITEM_BYTES)
    trimStringField(obj, "output", MAX_ITEM_BYTES)
    trimStringField(obj, "arguments", MAX_ITEM_BYTES)
    // Handle nested content arrays (e.g. multipart content with text parts)
    if (Array.isArray(obj.content)) {
      for (const part of obj.content) {
        const partObj = asRecord(part)
        if (partObj) trimStringField(partObj, "text", MAX_ITEM_BYTES)
      }
    }
  }
}

// Second pass: aggressively trim from oldest items (preserve last `preserve`)
function aggressiveTrimOldest(
  payload: Record<string, unknown>,
  input: Array<unknown>,
  preserve: number,
): number {
  const trimLimit = 200
  let bodySize = JSON.stringify(payload).length
  for (
    let i = 0;
    i < input.length - preserve && bodySize > MAX_BODY_BYTES;
    i++
  ) {
    const item = asRecord(input[i])
    if (!item) continue
    for (const field of ["content", "output", "arguments"] as const) {
      const val = item[field]
      if (typeof val === "string" && val.length > trimLimit) {
        item[field] = val.slice(0, trimLimit) + "\n[...truncated...]"
      }
    }
    if (i % 5 === 4) bodySize = JSON.stringify(payload).length
  }
  return JSON.stringify(payload).length
}

// Third pass: remove content from ALL items except the preserved tail
function removeContentFromOldest(
  payload: Record<string, unknown>,
  input: Array<unknown>,
  preserve: number,
): number {
  let bodySize = JSON.stringify(payload).length
  for (
    let i = 0;
    i < input.length - preserve && bodySize > MAX_BODY_BYTES;
    i++
  ) {
    const item = asRecord(input[i])
    if (!item) continue
    for (const field of ["content", "output", "arguments"] as const) {
      const val = item[field]
      if (typeof val === "string" && val.length > 20) {
        item[field] = "[removed]"
      }
    }
    if (Array.isArray(item.content)) {
      item.content = "[removed]"
    }
    if (i % 5 === 4) bodySize = JSON.stringify(payload).length
  }
  return JSON.stringify(payload).length
}

// Fourth pass: trim even the preserved tail items
function trimPreservedItems(
  payload: Record<string, unknown>,
  input: Array<unknown>,
  preserve: number,
): number {
  let bodySize = JSON.stringify(payload).length
  for (
    let i = input.length - preserve;
    i < input.length && bodySize > MAX_BODY_BYTES;
    i++
  ) {
    const item = asRecord(input[i])
    if (!item) continue
    for (const field of ["content", "output", "arguments"] as const) {
      trimStringField(item, field, 5000)
    }
    bodySize = JSON.stringify(payload).length
  }
  return bodySize
}

function trimResponsesInput(payload: Record<string, unknown>): void {
  // Trim instructions field if oversized
  trimStringField(payload, "instructions", MAX_INSTRUCTIONS_BYTES)

  const input = payload.input
  if (!Array.isArray(input)) return

  trimIndividualItems(input)

  if (JSON.stringify(payload).length <= MAX_BODY_BYTES) return

  consola.debug(
    `[responses] Payload ${(JSON.stringify(payload).length / 1024 / 1024).toFixed(2)}MB — trimming to fit under ${(MAX_BODY_BYTES / 1024 / 1024).toFixed(1)}MB`,
  )

  const preserve = Math.min(5, input.length)

  if (aggressiveTrimOldest(payload, input, preserve) <= MAX_BODY_BYTES) return
  if (removeContentFromOldest(payload, input, preserve) <= MAX_BODY_BYTES)
    return

  const bodySize = trimPreservedItems(payload, input, preserve)
  if (bodySize > MAX_BODY_BYTES) {
    consola.warn(
      `[responses] Payload still ${(bodySize / 1024 / 1024).toFixed(1)}MB after trimming — may hit 413`,
    )
  }
}
