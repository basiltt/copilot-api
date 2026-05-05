import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import {
  translateToResponsesPayload,
  translateFromResponsesResponse,
  translateFromResponsesStream,
  createResponsesStreamState,
} from "./responses-translation"

// Inactivity timeout for upstream fetches.  Unlike AbortSignal.timeout() which
// is a hard wall-clock deadline, this resets every time data arrives — so a
// slow-but-active stream (e.g. a 6000-line Write tool call) won't be killed
// as long as chunks keep flowing.  The timeout only fires when the upstream
// goes completely silent for this duration, indicating a stalled connection.
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes of silence
const MAX_TRANSIENT_HTTP_RETRIES = 3
const BASE_HTTP_RETRY_DELAY_MS = 750
const RETRIABLE_UPSTREAM_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

/**
 * Creates an AbortController with an inactivity timer that resets on each
 * call to `keepAlive()`.  If no keepAlive is received within `timeoutMs`,
 * the controller aborts with a descriptive TimeoutError.
 *
 * Call `clear()` when the operation finishes to prevent the timer from
 * firing after the stream is fully consumed.
 */
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

  // Start the initial timer immediately
  schedule()

  return {
    signal: controller.signal,
    /** Reset the inactivity timer — call on every received chunk. */
    keepAlive: schedule,
    /** Cancel the timer (call when the stream ends normally). */
    clear: () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}

function isRetriableUpstreamStatus(status: number): boolean {
  return RETRIABLE_UPSTREAM_STATUS_CODES.has(status)
}

function getRetryAfterDelayMs(retryAfter: string | null): number | undefined {
  if (!retryAfter) return undefined

  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }

  const retryAt = Date.parse(retryAfter)
  if (Number.isNaN(retryAt)) return undefined

  return Math.max(0, retryAt - Date.now())
}

function getTransientRetryDelayMs(response: Response, attempt: number): number {
  return (
    getRetryAfterDelayMs(response.headers.get("retry-after"))
    ?? BASE_HTTP_RETRY_DELAY_MS * 2 ** (attempt - 1)
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function buildRequestHeaders(
  payload: ChatCompletionsPayload,
): Record<string, string> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  return {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }
}

export const createResponsesCompletion = async (
  payload: ChatCompletionsPayload,
): Promise<
  ChatCompletionResponse | AsyncIterable<import("hono/streaming").SSEMessage>
> => {
  const headers = buildRequestHeaders(payload)

  const responsesPayload = translateToResponsesPayload(payload)

  const inactivity = createInactivityAbort()

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(responsesPayload),
    signal: inactivity.signal,
    // @ts-expect-error — Bun-specific option
    timeout: false,
  })

  // Headers arrived — reset the inactivity timer
  inactivity.keepAlive()

  if (!response.ok) {
    inactivity.clear()
    throw new HTTPError("Failed to create responses completion", response)
  }

  if (payload.stream) {
    const responseId = `resp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
    const model = payload.model
    const streamState = createResponsesStreamState()

    async function* streamChunks() {
      try {
        consola.debug("[responses-stream] Starting stream iteration")
        let eventCount = 0
        let yieldCount = 0
        for await (const event of events(response)) {
          inactivity.keepAlive()
          eventCount++
          consola.debug(
            `[responses-stream] Raw SSE event #${eventCount}:`,
            JSON.stringify({
              event: event.event,
              data: event.data?.slice(0, 200),
            }),
          )
          if (!event.data || event.data === "[DONE]") continue
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(event.data) as Record<string, unknown>
          } catch {
            consola.debug(
              "[responses-stream] Failed to parse event data as JSON",
            )
            continue
          }
          consola.debug(
            `[responses-stream] Parsed event type: ${parsed.type as string}`,
          )
          const chunk = translateFromResponsesStream(parsed, {
            responseId,
            model,
            streamState,
          })
          if (chunk) {
            const chunks = Array.isArray(chunk) ? chunk : [chunk]
            for (const c of chunks) {
              yieldCount++
              consola.debug(
                `[responses-stream] Yielding chunk #${yieldCount}:`,
                JSON.stringify(c).slice(0, 200),
              )
              yield c
            }
          } else {
            consola.debug(
              `[responses-stream] translateFromResponsesStream returned null for type: ${parsed.type as string}`,
            )
          }
        }
        consola.debug(
          `[responses-stream] Stream ended. Total events: ${eventCount}, yielded: ${yieldCount}`,
        )
        // Emit the [DONE] sentinel after all Responses API events have been
        // processed. The finish chunk (with finish_reason) is emitted by
        // translateFromResponsesStream on `response.completed`; this [DONE]
        // tells pipeStreamToClient to stop iterating.
        yield { data: "[DONE]" }
      } finally {
        inactivity.clear()
      }
    }

    return streamChunks()
  }

  inactivity.clear()
  const data = await response.json()
  return translateFromResponsesResponse(
    data as Parameters<typeof translateFromResponsesResponse>[0],
  )
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  const headers = buildRequestHeaders(payload)

  const inactivity = createInactivityAbort()

  // Newer models (gpt-5.x) reject `max_tokens` and require
  // `max_completion_tokens`. Claude models still use `max_tokens`.
  const { max_tokens, ...rest } = payload
  const usesMaxCompletionTokens =
    rest.model.startsWith("gpt-5") || rest.model.startsWith("o")
  let body: Record<string, unknown> = rest
  if (max_tokens !== null && max_tokens !== undefined) {
    const tokenKey =
      usesMaxCompletionTokens ? "max_completion_tokens" : "max_tokens"
    body = { ...rest, [tokenKey]: max_tokens }
  }

  let response: Response | undefined

  for (let attempt = 1; attempt <= MAX_TRANSIENT_HTTP_RETRIES; attempt++) {
    response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: inactivity.signal,
      // Bun's internal fetch timer defaults to ~4 minutes and fires mid-stream
      // when Copilot pauses between chunks on large (6000+ line) file edits.
      // Setting timeout:false disables it; the inactivity abort above is the
      // safety net — it only fires when the upstream goes completely silent.
      // @ts-expect-error — Bun-specific option, not in the standard fetch types
      timeout: false,
    })

    // Headers arrived — reset the inactivity timer
    inactivity.keepAlive()

    if (response.ok) break

    if (
      !isRetriableUpstreamStatus(response.status)
      || attempt === MAX_TRANSIENT_HTTP_RETRIES
    ) {
      inactivity.clear()
      throw new HTTPError("Failed to create chat completions", response)
    }

    const retryDelayMs = getTransientRetryDelayMs(response, attempt)
    consola.warn(
      `Copilot upstream returned ${response.status} on attempt ${attempt}/${MAX_TRANSIENT_HTTP_RETRIES}; retrying in ${retryDelayMs}ms`,
    )
    if (response.body) {
      void response.body.cancel().catch(() => undefined)
    }
    await sleep(retryDelayMs)
  }

  if (!response?.ok) {
    inactivity.clear()
    throw new Error("Copilot upstream did not produce a response")
  }

  if (payload.stream) {
    // Wrap the events iterator to reset the inactivity timer on each chunk
    // and clean up when the stream ends.  This ensures a slow-but-active
    // stream (e.g. a large Write tool call) is never killed prematurely.
    const upstream = events(response)

    async function* withInactivityReset() {
      try {
        for await (const event of upstream) {
          inactivity.keepAlive()
          yield event
        }
      } finally {
        inactivity.clear()
      }
    }

    return withInactivityReset()
  }

  inactivity.clear()
  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  /** Reasoning/thinking content from models that support it (e.g. GPT 5.4). */
  reasoning_content?: string | null
  /** Reasoning text from Gemini models (equivalent to reasoning_content). */
  reasoning_text?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?:
    | { type: "json_object" }
    | {
        type: "json_schema"
        json_schema: {
          name: string
          schema: Record<string, unknown>
          strict?: boolean
        }
      }
    | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  stream_options?: { include_usage: boolean } | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean // Structured Outputs — forwarded from Anthropic custom tool definitions
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
