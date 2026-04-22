import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkBurstLimit, checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"

const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000

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
  await checkBurstLimit(state)

  const payload = await c.req.json<Record<string, unknown>>()
  consola.debug("Responses API request:", JSON.stringify(payload).slice(-400))

  if (state.manualApprove) await awaitApproval()

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
