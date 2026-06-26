import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type { ResponsesPayload } from "~/services/copilot/responses-translation"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import {
  HTTPError,
  buildOpenAIContextWindowErrorBody,
  buildResponsesContextWindowFailedEvent,
  extractUpstreamErrorMessage,
  isContextWindowError,
} from "~/lib/error"
import { resolveModelId } from "~/lib/model-resolver"
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
const MAX_IMAGE_SEARCH_DEPTH = 12
const IMAGE_REMOVED_PLACEHOLDER =
  "[Image removed by proxy after Copilot rejected the request body]"
const imageRejectedWindowKeys = new Set<string>()

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

  const model = resolveAndApplyModel(payload)

  await checkBurstLimit(state, model)

  if (state.manualApprove) await awaitApproval()

  // Claude models don't support the Responses API — translate to Chat Completions
  if (requiresChatCompletionsApi(model)) {
    return handleViaCC(c, payload as unknown as ResponsesPayload)
  }

  if (!state.copilotToken) throw new Error("Copilot token not found")

  const inputArr = payload.input as Array<Record<string, unknown>> | undefined
  const isAgentCall = isAgentInitiatedCall(inputArr)

  dropEmptyToolChoice(payload)

  // Strip fields unsupported by the Copilot responses endpoint
  delete payload.store

  const inactivity = createInactivityAbort()
  const response = await fetchResponsesWithImageRetry(
    payload,
    isAgentCall,
    inactivity,
  )

  if (!response.ok) {
    inactivity.clear()
    return handleUpstreamError(c, response, payload.stream === true)
  }

  if (payload.stream === true) {
    return streamResponsesPassthrough(c, response, inactivity)
  }

  inactivity.clear()
  const data = await response.json()
  return c.json(data)
}

/**
 * Normalizes the requested model id (e.g. `claude-opus-4-8` →
 * `claude-opus-4.8`) to a real Copilot model and writes it back onto the
 * payload so the upstream request forwards the canonical id. Returns the
 * resolved model id.
 */
function resolveAndApplyModel(payload: Record<string, unknown>): string {
  const rawModel = typeof payload.model === "string" ? payload.model : ""
  const model = resolveModelId(rawModel, state.models)
  if (model !== rawModel) {
    consola.debug(`[model-resolver] '${rawModel}' → '${model}'`)
    payload.model = model
  }
  return model
}

/**
 * True when the input contains an assistant turn or tool call/output, marking
 * this as an agent-initiated request (forwarded via the `X-Initiator` header).
 */
function isAgentInitiatedCall(
  inputArr: Array<Record<string, unknown>> | undefined,
): boolean {
  return (
    Array.isArray(inputArr)
    && inputArr.some((item) => {
      const role = typeof item.role === "string" ? item.role : ""
      const type = typeof item.type === "string" ? item.type : ""
      return ["assistant", "function_call", "function_call_output"].includes(
        role || type,
      )
    })
  )
}

/** Drop tool_choice when no tools are present — the API rejects this combination. */
function dropEmptyToolChoice(payload: Record<string, unknown>): void {
  if (payload.tool_choice === undefined) return
  const tools = payload.tools as Array<unknown> | undefined
  if (!tools || tools.length === 0) {
    delete payload.tool_choice
  }
}

/**
 * Posts a body to the upstream /responses endpoint, refreshing the inactivity
 * timer once the response headers arrive.
 *
 * Forward the body VERBATIM. We deliberately do NOT trim or mutate the input:
 * Codex owns its conversation state and compacts on its own (driven by the
 * usage.total_tokens it reads back from each response, against the
 * model_auto_compact_token_limit in .codex/config.toml). Any proxy-side
 * trimming corrupts that state — it desyncs Codex's token accounting from
 * what Copilot actually received and can silently drop conversation data,
 * degrading the model. If the body ever exceeds Copilot's real limit, the
 * upstream returns a context-window error which we translate into the signal
 * Codex needs to compact (sendResponsesContextWindowError).
 */
async function postResponsesUpstream(
  body: Record<string, unknown>,
  inactivity: ReturnType<typeof createInactivityAbort>,
  opts: { enableVision: boolean; isAgentCall: boolean },
): Promise<Response> {
  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers: {
      ...copilotHeaders(state, opts.enableVision),
      "X-Initiator": opts.isAgentCall ? "agent" : "user",
    },
    body: JSON.stringify(body),
    signal: inactivity.signal,
    // @ts-expect-error — Bun-specific option
    timeout: false,
  })
  inactivity.keepAlive()
  return response
}

/**
 * Sends the upstream /responses request, replacing images the upstream has
 * previously rejected (or rejects on this attempt with an opaque "failed to
 * parse request") with text placeholders before retrying.
 */
async function fetchResponsesWithImageRetry(
  payload: Record<string, unknown>,
  isAgentCall: boolean,
  inactivity: ReturnType<typeof createInactivityAbort>,
): Promise<Response> {
  const imageWindowKey = getImageWindowKey(payload)
  let upstreamPayload = payload
  let enableVision = containsInputImage(payload.input)

  if (
    enableVision
    && imageWindowKey
    && imageRejectedWindowKeys.has(imageWindowKey)
  ) {
    const strippedPayload = structuredClone(payload)
    const strippedImages = stripInputImages(strippedPayload.input)
    if (strippedImages > 0) {
      consola.debug(
        `[responses] Replacing ${strippedImages} previously rejected image(s) before upstream request for ${imageWindowKey}.`,
      )
      upstreamPayload = strippedPayload
      enableVision = containsInputImage(strippedPayload.input)
    }
  }

  const response = await postResponsesUpstream(upstreamPayload, inactivity, {
    enableVision,
    isAgentCall,
  })

  if (
    !response.ok
    && enableVision
    && (await isOpaquePayloadParseFailure(response))
  ) {
    const strippedPayload = structuredClone(payload)
    const strippedImages = stripInputImages(strippedPayload.input)
    if (strippedImages > 0) {
      if (imageWindowKey) imageRejectedWindowKeys.add(imageWindowKey)
      consola.warn(
        `[responses] Upstream rejected an image payload as "failed to parse request"; retrying with ${strippedImages} image(s) replaced by text placeholders.`,
      )
      return postResponsesUpstream(strippedPayload, inactivity, {
        enableVision: containsInputImage(strippedPayload.input),
        isAgentCall,
      })
    }
  }

  return response
}

/**
 * Handles a non-ok upstream response: translates a context-window overflow into
 * the signal Codex needs to compact, otherwise throws an HTTPError.
 */
async function handleUpstreamError(
  c: Context,
  response: Response,
  isStreaming: boolean,
): Promise<Response> {
  const ctxError = await detectContextWindowError(response)
  if (ctxError) {
    return sendResponsesContextWindowError(c, isStreaming, ctxError)
  }
  throw new HTTPError("Failed to create responses completion", response)
}

function getImageWindowKey(
  payload: Record<string, unknown>,
): string | undefined {
  const windowId = findStringProperty(payload, [
    "x-codex-window-id",
    "window_id",
  ])
  if (windowId) return `window:${windowId}`

  const sessionId = findStringProperty(payload, ["session_id", "thread_id"])
  return sessionId ? `session:${sessionId}` : undefined
}

function findStringProperty(
  value: unknown,
  names: Array<string>,
  depth = 0,
): string | undefined {
  if (depth > MAX_IMAGE_SEARCH_DEPTH) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringProperty(item, names, depth + 1)
      if (found) return found
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined

  const obj = value as Record<string, unknown>
  for (const name of names) {
    const candidate = obj[name]
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate
    }
  }

  for (const child of Object.values(obj)) {
    const found = findStringProperty(child, names, depth + 1)
    if (found) return found
  }
  return undefined
}

/** Streams a successful upstream /responses SSE body straight through to the client. */
function streamResponsesPassthrough(
  c: Context,
  response: Response,
  inactivity: ReturnType<typeof createInactivityAbort>,
) {
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

/**
 * Reads an upstream error response and, if it indicates a context-window
 * overflow (HTTP 413 or a recognizable message), returns the extracted upstream
 * message. Returns null for unrelated errors.
 *
 * Reads from a clone so the original response body stays intact for
 * `forwardError` when this is not a context-window error.
 */
async function detectContextWindowError(
  response: Response,
): Promise<{ message: string } | null> {
  const errorText = await response.clone().text()
  let errorJson: unknown
  try {
    errorJson = JSON.parse(errorText)
  } catch {
    errorJson = null
  }
  const message = extractUpstreamErrorMessage(
    errorJson,
    errorText,
    response.headers.get("content-type"),
  )
  if (!isContextWindowError(message, response.status)) return null
  return { message }
}

async function isOpaquePayloadParseFailure(
  response: Response,
): Promise<boolean> {
  if (response.status !== 413) return false

  const errorText = await response.clone().text()
  let errorJson: unknown
  try {
    errorJson = JSON.parse(errorText)
  } catch {
    errorJson = null
  }
  const message = extractUpstreamErrorMessage(
    errorJson,
    errorText,
    response.headers.get("content-type"),
  )

  return message.trim().toLowerCase() === "failed to parse request"
}

function containsInputImage(value: unknown, depth = 0): boolean {
  if (depth > MAX_IMAGE_SEARCH_DEPTH) return false
  if (Array.isArray(value)) {
    return value.some((item) => containsInputImage(item, depth + 1))
  }
  if (typeof value !== "object" || value === null) return false

  const obj = value as Record<string, unknown>
  if (obj.type === "input_image" && typeof obj.image_url === "string") {
    return true
  }

  return Object.values(obj).some((item) => containsInputImage(item, depth + 1))
}

function isInputImageObject(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && (value as Record<string, unknown>).type === "input_image"
    && typeof (value as Record<string, unknown>).image_url === "string"
  )
}

function replacementImageText() {
  return {
    type: "input_text",
    text: IMAGE_REMOVED_PLACEHOLDER,
  }
}

function stripInputImages(value: unknown, depth = 0): number {
  if (depth > MAX_IMAGE_SEARCH_DEPTH) return 0

  if (Array.isArray(value)) {
    let stripped = 0
    for (let i = 0; i < value.length; i++) {
      if (isInputImageObject(value[i])) {
        value[i] = replacementImageText()
        stripped += 1
      } else {
        stripped += stripInputImages(value[i], depth + 1)
      }
    }
    return stripped
  }

  if (typeof value !== "object" || value === null) return 0

  let stripped = 0
  const obj = value as Record<string, unknown>
  for (const [key, child] of Object.entries(obj)) {
    if (isInputImageObject(child)) {
      obj[key] = replacementImageText()
      stripped += 1
    } else {
      stripped += stripInputImages(child, depth + 1)
    }
  }
  return stripped
}

/**
 * Emits a context-window error in the form the OpenAI Codex CLI recognizes so
 * it triggers auto-compaction instead of failing.
 *
 * For streaming requests this MUST be a 200 OK SSE stream carrying a
 * `response.failed` event with `error.code = "context_length_exceeded"` —
 * Codex's transport layer discards the body of any non-2xx response before its
 * SSE parser (and thus the context-window detector) ever runs.
 *
 * For non-streaming requests we return a standard OpenAI-shaped 400 error
 * carrying the same `code`.
 */
function sendResponsesContextWindowError(
  c: Context,
  isStreaming: boolean,
  ctxError: { message: string },
) {
  consola.warn(
    `[responses] Context window exceeded — signaling Codex to compact (code=context_length_exceeded). Upstream: "${ctxError.message}"`,
  )

  if (isStreaming) {
    return streamSSE(c, async (stream) => {
      const event = buildResponsesContextWindowFailedEvent(ctxError.message)
      // Codex's process_sse only surfaces the parsed error once the stream
      // ends, so we write the single response.failed event and let the stream
      // close (matching real OpenAI, which sends no [DONE] on a failed turn).
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    })
  }

  return c.json(buildOpenAIContextWindowErrorBody(ctxError.message), 400)
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
