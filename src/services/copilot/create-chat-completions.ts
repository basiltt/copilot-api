import consola from "consola"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { abortableDelay, requestSignal } from "~/lib/request-lifecycle"
import { state } from "~/lib/state"
import {
  createInactivityAbort,
  fetchWithInactivity,
  readResponseBody,
  responseEvents,
} from "~/lib/upstream-lifecycle"

import {
  translateToResponsesPayload,
  translateFromResponsesResponse,
  translateFromResponsesStream,
  createResponsesStreamState,
} from "./responses-translation"

const MAX_TRANSIENT_HTTP_RETRIES = 5
const BASE_HTTP_RETRY_DELAY_MS = 750
const RETRIABLE_UPSTREAM_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])
const finalUpstreamRequestShape = Symbol("finalUpstreamRequestShape")

export interface FinalUpstreamRequestShape {
  endpoint: "chat_completions" | "messages" | "responses"
  tokenField:
    | "max_tokens"
    | "max_completion_tokens"
    | "max_output_tokens"
    | "absent"
    | "multiple"
  tokenValue: number | null
  stream: boolean | null
  oneShot: boolean
  nativeRouting:
    | "native_selected"
    | "native_disabled"
    | "model_not_advertised"
    | "request_unsupported"
    | "not_applicable"
  nativeRejectionReasons?: Array<NativeMessagesRejectionReason>
}

export type NativeMessagesRejectionReason =
  | "assistant_block_unsupported"
  | "container"
  | "context_management"
  | "effort_unsupported"
  | "max_tokens_invalid"
  | "mcp_servers"
  | "message_content_invalid"
  | "message_nonobject"
  | "message_role_absent"
  | "message_role_developer"
  | "message_role_other"
  | "message_role_system"
  | "message_role_system_nonprefix"
  | "message_role_tool"
  | "output_format"
  | "redacted_thinking_invalid"
  | "system_block_unsupported"
  | "thinking_invalid"
  | "thinking_signature_missing"
  | "tool_result_content_missing"
  | "tool_result_content_unsupported"
  | "tool_use_invalid"
  | "typed_tools"
  | "user_block_unsupported"

interface RequestShapeOptions {
  endpoint: FinalUpstreamRequestShape["endpoint"]
  nativeRejectionReasons?: Array<NativeMessagesRejectionReason>
  nativeRouting?: FinalUpstreamRequestShape["nativeRouting"]
  oneShot: boolean
}

function describeFinalUpstreamRequest(
  body: Record<string, unknown>,
  options: RequestShapeOptions,
): FinalUpstreamRequestShape {
  const tokenFields = (
    ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const
  ).filter((field) => Object.hasOwn(body, field))
  let tokenField: FinalUpstreamRequestShape["tokenField"] = "multiple"
  if (tokenFields.length === 0) tokenField = "absent"
  if (tokenFields.length === 1) tokenField = tokenFields[0]
  const tokenCandidate =
    tokenFields.length === 1 ? body[tokenFields[0]] : undefined
  const tokenValue =
    typeof tokenCandidate === "number" && Number.isFinite(tokenCandidate) ?
      tokenCandidate
    : null

  return {
    endpoint: options.endpoint,
    tokenField,
    tokenValue,
    stream: typeof body.stream === "boolean" ? body.stream : null,
    oneShot: options.oneShot,
    nativeRouting: options.nativeRouting ?? "not_applicable",
    ...(options.nativeRejectionReasons?.length ?
      { nativeRejectionReasons: options.nativeRejectionReasons }
    : {}),
  }
}

export function attachFinalUpstreamRequestShape<T extends object>(
  value: T,
  shape: FinalUpstreamRequestShape,
): T {
  Object.defineProperty(value, finalUpstreamRequestShape, {
    value: shape,
    enumerable: false,
  })
  return value
}

export function getFinalUpstreamRequestShape(
  value: unknown,
): FinalUpstreamRequestShape | undefined {
  if (value === null || typeof value !== "object") return undefined
  return (value as { [finalUpstreamRequestShape]?: FinalUpstreamRequestShape })[
    finalUpstreamRequestShape
  ]
}

function isRetriableUpstreamStatus(status: number): boolean {
  return RETRIABLE_UPSTREAM_STATUS_CODES.has(status)
}

// Substrings identifying invalid_request_body errors that are DETERMINISTIC —
// caused by the shape of the request itself, so retrying the identical payload
// can never succeed. Matching these short-circuits the retry loop instead of
// burning all MAX_TRANSIENT_HTTP_RETRIES attempts (~16s) on a doomed request.
// Matched case-insensitively against the upstream error message.
const DETERMINISTIC_BODY_ERROR_SIGNATURES = [
  "assistant message prefill",
  "must end with a user message",
  "must be a response to a preceeding message", // upstream's spelling
  "must be a response to a preceding message",
  "must have a corresponding tool_use",
  "unexpected tool_use_id",
  "exceeds the limit", // context-window / max-prompt-tokens errors
  "exceeds the maximum",
] as const

function isDeterministicBodyErrorMessage(
  message: string,
  reasoningEffort?: string | null,
): boolean {
  const lower = message.toLowerCase()
  // Match the effort actually sent, without changing unrelated body-error
  // retries or the Anthropic path (which does not send reasoning_effort).
  const isEffortError =
    typeof reasoningEffort === "string"
    && lower.includes("supported values are:")
    && (lower.includes(`invalid value: '${reasoningEffort.toLowerCase()}'`)
      || lower.includes(
        `unsupported value: '${reasoningEffort.toLowerCase()}'`,
      ))
  return (
    isEffortError
    || DETERMINISTIC_BODY_ERROR_SIGNATURES.some((sig) => lower.includes(sig))
  )
}

async function isRetriableBodyError(
  response: Response,
  reasoningEffort?: string | null,
): Promise<boolean> {
  if (response.status !== 400) return false
  try {
    const cloned = response.clone()
    const body = (await cloned.json()) as {
      error?: { code?: string; message?: string }
    }
    if (body.error?.code !== "invalid_request_body") return false
    // Deterministic request-shape errors (assistant prefill, role ordering,
    // orphaned tool_result, context-window overflow) cannot be fixed by
    // retrying the same payload — fail fast instead of looping.
    if (
      body.error.message
      && isDeterministicBodyErrorMessage(body.error.message, reasoningEffort)
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
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

// eslint-disable-next-line max-lines-per-function -- Streaming and nonstreaming Responses share one request lifecycle and exact wire metadata.
export const createResponsesCompletion = async (
  payload: ChatCompletionsPayload,
  nativeRouting: FinalUpstreamRequestShape["nativeRouting"] = "not_applicable",
  nativeRejectionReasons?: Array<NativeMessagesRejectionReason>,
): Promise<
  ChatCompletionResponse | AsyncIterable<import("hono/streaming").SSEMessage>
> => {
  const headers = buildRequestHeaders(payload)

  const responsesPayload = translateToResponsesPayload(payload)
  const requestShape = describeFinalUpstreamRequest(
    responsesPayload as unknown as Record<string, unknown>,
    {
      endpoint: "responses",
      oneShot: false,
      nativeRouting,
      nativeRejectionReasons,
    },
  )

  const inactivity = createInactivityAbort()

  const response = await fetchWithInactivity(
    `${copilotBaseUrl(state)}/responses`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(responsesPayload),
      signal: inactivity.signal,
      // @ts-expect-error — Bun-specific option
      timeout: false,
    },
    inactivity,
  )

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
        for await (const event of responseEvents(response, inactivity.signal)) {
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

    return attachFinalUpstreamRequestShape(streamChunks(), requestShape)
  }

  try {
    const data: unknown = JSON.parse(
      await readResponseBody(response, inactivity.signal, inactivity.keepAlive),
    )
    return attachFinalUpstreamRequestShape(
      translateFromResponsesResponse(
        data as Parameters<typeof translateFromResponsesResponse>[0],
      ),
      requestShape,
    )
  } finally {
    inactivity.clear()
  }
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  nativeRouting: FinalUpstreamRequestShape["nativeRouting"] = "not_applicable",
  nativeRejectionReasons?: Array<NativeMessagesRejectionReason>,
) => {
  const headers = buildRequestHeaders(payload)

  const inactivity = createInactivityAbort()

  const body = buildChatRequestBody(payload)
  const requestShape = describeFinalUpstreamRequest(body, {
    endpoint: "chat_completions",
    oneShot: false,
    nativeRouting,
    nativeRejectionReasons,
  })

  let response: Response | undefined

  for (let attempt = 1; attempt <= MAX_TRANSIENT_HTTP_RETRIES; attempt++) {
    response = await fetchWithInactivity(
      `${copilotBaseUrl(state)}/chat/completions`,
      {
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
      },
      inactivity,
    )

    // Headers arrived — reset the inactivity timer
    inactivity.keepAlive()

    if (response.ok) break

    const shouldRetry =
      isRetriableUpstreamStatus(response.status)
      || (await isRetriableBodyError(response, payload.reasoning_effort))

    if (!shouldRetry || attempt === MAX_TRANSIENT_HTTP_RETRIES) {
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
    await abortableDelay(retryDelayMs, inactivity.signal)
  }

  if (!response?.ok) {
    inactivity.clear()
    throw new Error("Copilot upstream did not produce a response")
  }

  if (payload.stream) {
    // Wrap the events iterator to reset the inactivity timer on each chunk
    // and clean up when the stream ends.  This ensures a slow-but-active
    // stream (e.g. a large Write tool call) is never killed prematurely.
    const upstream = responseEvents(response, inactivity.signal)

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

    return attachFinalUpstreamRequestShape(withInactivityReset(), requestShape)
  }

  try {
    return attachFinalUpstreamRequestShape(
      JSON.parse(
        await readResponseBody(
          response,
          inactivity.signal,
          inactivity.keepAlive,
        ),
      ) as ChatCompletionResponse,
      requestShape,
    )
  } finally {
    inactivity.clear()
  }
}

function buildChatRequestBody(
  payload: ChatCompletionsPayload,
): Record<string, unknown> {
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

  return body
}

function describeOneShotRequest(
  body: Record<string, unknown>,
  options: {
    usesResponses: boolean
    nativeRejectionReasons?: Array<NativeMessagesRejectionReason>
    nativeRouting: FinalUpstreamRequestShape["nativeRouting"]
  },
): FinalUpstreamRequestShape {
  return describeFinalUpstreamRequest(body, {
    endpoint: options.usesResponses ? "responses" : "chat_completions",
    oneShot: true,
    nativeRouting: options.nativeRouting,
    nativeRejectionReasons: options.nativeRejectionReasons,
  })
}

interface OneShotCompletionOptions {
  usesResponses: boolean
  signal: AbortSignal
  nativeRejectionReasons?: Array<NativeMessagesRejectionReason>
  nativeRouting?: FinalUpstreamRequestShape["nativeRouting"]
}

/** One non-streaming request, including body consumption, with no hidden retries. */
export async function createOneShotCompletion(
  payload: ChatCompletionsPayload,
  options: OneShotCompletionOptions,
): Promise<ChatCompletionResponse> {
  const {
    usesResponses,
    signal,
    nativeRejectionReasons,
    nativeRouting = "not_applicable",
  } = options
  const downstream = requestSignal()
  const combined = downstream ? AbortSignal.any([signal, downstream]) : signal
  combined.throwIfAborted()
  const nonStreaming = { ...payload, stream: false, stream_options: undefined }
  const body =
    usesResponses ?
      translateToResponsesPayload(nonStreaming)
    : buildChatRequestBody(nonStreaming)
  const requestShape = describeOneShotRequest(body as Record<string, unknown>, {
    usesResponses,
    nativeRouting,
    nativeRejectionReasons,
  })
  const response = await fetch(
    `${copilotBaseUrl(state)}/${usesResponses ? "responses" : "chat/completions"}`,
    {
      method: "POST",
      headers: buildRequestHeaders(payload),
      body: JSON.stringify(body),
      signal: combined,
      // @ts-expect-error — Bun-specific option; the caller owns the deadline.
      timeout: false,
    },
  )
  const text = await readResponseBody(response, combined)
  if (!response.ok) {
    throw new HTTPError(
      "Copilot completion failed",
      new Response(text, {
        status: response.status,
        headers: response.headers,
      }),
    )
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new HTTPError(
      "Invalid Copilot completion",
      Response.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: "Upstream completion contained malformed JSON.",
          },
        },
        { status: 502 },
      ),
    )
  }
  if (data === null || typeof data !== "object") {
    throw new HTTPError(
      "Invalid Copilot completion",
      Response.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: "Upstream completion was not an object.",
          },
        },
        { status: 502 },
      ),
    )
  }
  if ("error" in data && data.error) {
    throw new HTTPError(
      "Copilot completion failed",
      Response.json(data, { status: 502 }),
    )
  }
  if (usesResponses) {
    return attachFinalUpstreamRequestShape(
      translateFromResponsesResponse(
        data as Parameters<typeof translateFromResponsesResponse>[0],
        true,
      ),
      requestShape,
    )
  }
  return attachFinalUpstreamRequestShape(
    data as ChatCompletionResponse,
    requestShape,
  )
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
      cache_creation_tokens?: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens?: number
      rejected_prediction_tokens?: number
      reasoning_tokens?: number
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
      cache_creation_tokens?: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens?: number
      rejected_prediction_tokens?: number
      reasoning_tokens?: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  refusal?: string | null
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
  parallel_tool_calls?: boolean
  user?: string | null
  stream_options?: { include_usage: boolean } | null
  reasoning_effort?: string | null

  /**
   * Reasoning controls for the Responses API path (gpt-5.x and other reasoning
   * models). When the incoming Anthropic request has extended thinking enabled,
   * we set `summary: "auto"` so Copilot streams `reasoning_summary_text.delta`
   * events in real time — without it, the model reasons silently and no
   * thinking deltas are emitted (the thinking appears all at once at the end).
   */
  reasoning?: { effort?: string; summary?: string } | null
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
