/* eslint-disable max-lines */
import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import {
  extractUpstreamErrorMessage,
  HTTPError,
  isContextWindowError,
  formatAnthropicContextWindowError,
  sendAnthropicContextWindowError,
  sendAnthropicInvalidRequestError,
} from "~/lib/error"
import { knownModelMetadata, isFable51 } from "~/lib/known-models"
import { resolveModelId } from "~/lib/model-resolver"
import { checkAdmission } from "~/lib/rate-limit"
import {
  requestSignal,
  streamSSE,
  throwIfRequestAborted,
} from "~/lib/request-lifecycle"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  createOneShotCompletion,
  createResponsesCompletion,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  getModelContextWindow,
  getModelMaxOutput,
} from "~/services/copilot/get-models"
import { requiresResponsesApi } from "~/services/copilot/responses-translation"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
  isThinkingRequested,
} from "./anthropic-types"
import {
  CompactionNeededError,
  fetchWithImageStripping,
  type ImageStrippingResult,
  updateImageFlag,
} from "./image-stripping"
import { findInvalidEmbeddedImage } from "./image-validation"
import { applyLargeEditGuidance } from "./large-edit-guidance"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  isServerWebSearch,
  runServerWebSearch,
  serverSearchLimit,
} from "./server-web-search"
import {
  flushDeferredFinish,
  isEmptyStreamResponse,
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"
import {
  type OutputCompletion,
  translateWithOutputRecovery,
  usesStructuredOutputRecovery,
} from "./structured-output-recovery"
import { ToolSchemaMismatchError } from "./tool-input"
import {
  createToolNameMapFromAnthropicPayload,
  type ToolNameMap,
} from "./tool-name-mapping"
import { EMPTY_VISIBLE_OUTPUT_TEXT, toAnthropicMessageId } from "./utils"
import {
  hasLogicalWriteTool,
  translateWithWriteRecovery,
  usesWriteToolRecovery,
} from "./write-tool-recovery"

// Interval at which SSE ping events are sent to keep the downstream
// connection alive while waiting for Copilot to start responding or
// between chunks during slow generation (e.g. large file writes).
// Must be shorter than both the network's TCP idle timeout (~5 min on
// enterprise firewalls) and Claude Code's stream inactivity detector
// (~45s).  10 seconds gives comfortable headroom for both.
const PING_INTERVAL_MS = 10_000

/**
 * Sends recurring Anthropic ping events until the caller stops the keepalive.
 *
 * A one-shot timer is insufficient: after that single ping, nginx's default
 * 60-second upstream idle timeout can close a still-running workflow stream
 * before the 90-second upstream stall recovery emits `message_stop`.
 */
export function startSSEKeepalive(
  stream: Pick<SSEStreamingApi, "writeSSE">,
  intervalMs: number = PING_INTERVAL_MS,
): () => void {
  const signal = requestSignal()
  const stop = () => {
    clearInterval(timer)
    signal?.removeEventListener("abort", stop)
  }
  const timer = setInterval(() => {
    consola.debug("Sending periodic SSE ping")
    stream
      .writeSSE({ event: "ping", data: JSON.stringify({ type: "ping" }) })
      .catch((error: unknown) => {
        stop()
        consola.debug("Stopping SSE keepalive after write failure:", error)
      })
  }, intervalMs)

  signal?.addEventListener("abort", stop, { once: true })
  if (signal?.aborted) stop()
  return stop
}

// Maximum time to wait for the next upstream chunk inside pipeStreamToClient
// before assuming the stream is stalled.  When the Copilot API finishes
// streaming a large tool call (e.g. 6000+ line Write), it sometimes never
// sends the chunk containing `finish_reason` — the HTTP body remains open
// and `reader.read()` blocks indefinitely.  Models like Gemini 3 Pro can
// have long pauses (60-90s) between reasoning chunks while doing deep
// internal processing.  The downstream stays alive via PING_INTERVAL_MS,
// so the only constraint here is how long we wait for a genuinely stalled
// upstream.  90s accommodates long reasoning phases while still recovering
// from truly dead connections within a reasonable time.
const STREAM_STALL_TIMEOUT_MS = 90_000
const STREAM_TIMED_OUT = Symbol("stream-timed-out")

// Maximum number of times to retry a timed-out upstream fetch before giving up.
// Each attempt gets a fresh TCP connection, resetting the firewall idle timer.
// Retry is safe because we only retry before the first byte arrives — if Copilot
// hasn't started generating yet, the request is idempotent.
const MAX_FETCH_RETRIES = 3

// Maximum number of times to retry when the model returns an empty response
// (finish_reason "stop" with no content or tool calls).  Some models
// (notably Gemini) occasionally do this after their reasoning phase completes
// without producing output.  Retrying typically succeeds on the next attempt.
const MAX_EMPTY_RESPONSE_RETRIES = 2

// Error name/code patterns that indicate a retriable network failure
// (firewall idle timeout, connection reset) vs. a non-retriable one (4xx, auth).
const RETRIABLE_ERROR_NAMES = new Set([
  "TimeoutError",
  "ECONNRESET",
  "FailedToOpenSocket",
  "ConnectionRefused",
])

/**
 * Classifies whether a thrown fetch error is a transient network failure that
 * is safe to retry (before any response byte has arrived).
 *
 * Bun/undici surface these markers inconsistently: an inactivity abort sets
 * `error.name = "TimeoutError"`, while a raw socket reset arrives as a plain
 * `Error` with the marker on `error.code` (e.g. `ECONNRESET`).  Checking only
 * `.name` (the previous behavior) let connection resets fall through to a hard
 * 500 instead of being retried.  We match against both.
 */
export function isRetriableFetchError(error: unknown): error is Error {
  if (requestSignal()?.aborted) return false
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return (
    RETRIABLE_ERROR_NAMES.has(error.name)
    || (typeof code === "string" && RETRIABLE_ERROR_NAMES.has(code))
  )
}

const MODELS_WITH_1M_CONTEXT = new Set([
  "claude-opus-4.6",
  "claude-opus-4.7",
  "claude-opus-4.8",
  "claude-sonnet-4.6",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gpt-5.4",
  "gpt-5.5",
])
const EFFECTIVE_1M_LIMIT = 935_000

/**
 * Looks up the model's max_prompt_tokens limit from cached models.
 * Used to produce accurate "prompt is too long: N tokens > M maximum"
 * errors even when the upstream error doesn't contain token numbers.
 */
function lookupModelLimit(modelId: string): number | undefined {
  const known = knownModelMetadata(modelId)
  if (known) {
    const model = state.models?.data.find((entry) => entry.id === modelId)
    return getModelContextWindow(model ?? known)
  }
  if (MODELS_WITH_1M_CONTEXT.has(modelId)) return EFFECTIVE_1M_LIMIT
  const model = state.models?.data.find((m) => m.id === modelId)
  return model ? getModelContextWindow(model) : undefined
}

// eslint-disable-next-line complexity, max-lines-per-function -- Keep route precedence and shared error recovery explicit.
export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  if (
    !usesStructuredOutputRecovery(anthropicPayload)
    && !hasLogicalWriteTool(anthropicPayload)
  ) {
    consola.debug(
      "Anthropic request payload:",
      JSON.stringify(anthropicPayload),
    )
  }

  // Normalize the requested model id (e.g. `claude-opus-4-8` → `claude-opus-4.8`)
  // to a real Copilot model before any downstream lookup or forwarding.
  const resolvedModel = resolveModelId(anthropicPayload.model, state.models)
  if (resolvedModel !== anthropicPayload.model) {
    consola.debug(
      `[model-resolver] '${anthropicPayload.model}' → '${resolvedModel}'`,
    )
    anthropicPayload.model = resolvedModel
  }

  await checkAdmission(state, { model: anthropicPayload.model })

  if (
    isFable51(anthropicPayload.model)
    && (anthropicPayload.tool_choice?.type === "any"
      || anthropicPayload.tool_choice?.type === "tool")
  ) {
    return sendAnthropicInvalidRequestError(
      c,
      "Claude Fable 5.1 does not support forced tool use (tool_choice any/tool). Use auto or none; the proxy will not silently change the model or tool mode.",
    )
  }

  const invalidImage = findInvalidEmbeddedImage(anthropicPayload)
  if (invalidImage) {
    return sendAnthropicInvalidRequestError(
      c,
      `Embedded ${invalidImage.mediaType} image is too small to process reliably `
        + `(${invalidImage.width}x${invalidImage.height}). `
        + "This guard only blocks tiny placeholder-style images and does not "
        + "affect normal screenshots or UI attachments. Use an image at least "
        + "4x4 pixels.",
    )
  }

  // Check if compaction has removed images from this session's conversation.
  // This clears the per-session image-stripped flag so count_tokens stops
  // returning the inflated 200K value for this session.
  updateImageFlag(anthropicPayload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const searchLimit = serverSearchLimit(anthropicPayload)
  if (
    searchLimit !== undefined
    && anthropicPayload.tool_choice?.type === "none"
  ) {
    anthropicPayload.tools = anthropicPayload.tools?.filter(
      (tool) => !isServerWebSearch(tool),
    )
  }

  // NOTE: We intentionally do NOT pre-flight reject requests based on local
  // token estimation.  Returning an Anthropic-formatted "invalid_request_error"
  // causes Claude Code to auto-compact and retry in a loop — each retry adds
  // more context, making the prompt even larger.  Instead we let the request
  // through to Copilot and rely on forwardError to return the raw Copilot
  // error JSON (not Anthropic format), which Claude Code won't retry.

  // Structured output requests (e.g. title generation) use output_config.format.
  // The Copilot Chat Completions API does not enforce response_format, so the
  // model may return free text instead of JSON.  Handle these specially: force
  // non-streaming, validate/repair the JSON, and emit as SSE if the original
  // request was streaming.
  if (anthropicPayload.output_config?.format) {
    return handleStructuredOutput(c, anthropicPayload)
  }

  if (
    searchLimit !== undefined
    && anthropicPayload.tool_choice?.type !== "none"
    && !looksLikeCompactionRequest(anthropicPayload)
  ) {
    return handleServerSearch(c, anthropicPayload, searchLimit)
  }
  if (
    (usesStructuredOutputRecovery(anthropicPayload)
      || usesWriteToolRecovery(anthropicPayload))
    && !looksLikeCompactionRequest(anthropicPayload)
  ) {
    return handleOutputTool(c, anthropicPayload)
  }
  // For non-streaming requests just fetch and translate synchronously —
  // no SSE connection needed, so no ping mechanism required.
  if (!anthropicPayload.stream) {
    return handleNonStreaming(c, anthropicPayload)
  }

  if (looksLikeCompactionRequest(anthropicPayload)) {
    try {
      const result = await fetchCompactionResponse(anthropicPayload)
      const toolNameMap =
        createToolNameMapFromAnthropicPayload(anthropicPayload)
      return streamSSE(c, async (stream) => {
        await emitNonStreamingAsSSE(stream, result.response, {
          imageTokenOverhead: estimateTokensForStrippedImages(
            result.strippedBase64Chars,
          ),
          toolNameMap,
        })
      })
    } catch (error) {
      const contextWindowMessage = await extractContextWindowMessage(error)
      if (error instanceof CompactionNeededError || contextWindowMessage) {
        const modelLimit = lookupModelLimit(anthropicPayload.model)
        return sendAnthropicContextWindowError(c, contextWindowMessage ?? "", {
          status: 400,
          modelLimit,
        })
      }
      throw error
    }
  }

  // Attempt upstream fetch BEFORE opening the SSE connection so context-window
  // errors surface as HTTP-level responses (400 + invalid_request_error) that
  // Claude Code recognizes for auto-compaction.  SSE error events inside an
  // already-committed HTTP 200 stream do NOT trigger compaction.
  try {
    const strippingResult = await prefetchCopilotResponse(anthropicPayload)
    return streamSSE(c, (stream) =>
      handleStreaming(stream, anthropicPayload, strippingResult),
    )
  } catch (error) {
    // Context window errors (HTTP 400 with "exceeds the context window")
    // or CompactionNeededError (413 cascade exhausted): return 400 with
    // Anthropic-formatted invalid_request_error in the exact format
    // Claude Code expects: "prompt is too long: N tokens > M maximum".
    const contextWindowMessage = await extractContextWindowMessage(error)
    if (error instanceof CompactionNeededError || contextWindowMessage) {
      const modelLimit = lookupModelLimit(anthropicPayload.model)
      consola.debug(
        `[context-window] Upstream error: "${contextWindowMessage}", modelLimit=${modelLimit}`,
      )
      return sendAnthropicContextWindowError(c, contextWindowMessage ?? "", {
        status: 400,
        modelLimit,
      })
    }

    // All other errors: let route-level forwardError handle them
    throw error
  }
}

/**
 * Estimates the token cost of stripped base64 image data.
 * Used to inflate response `input_tokens` so Claude Code sees the true
 * context size and triggers compaction when images accumulate.
 *
 * Per Anthropic's docs, images cost ~(width*height)/750 tokens, with a
 * practical maximum of ~1,600 tokens per image.  Since we don't know the
 * original dimensions, we use 1,600 as a conservative ceiling.
 *
 * A typical screenshot is ~200KB base64 (~267,000 chars).  Dividing by
 * a generous 200K-chars-per-image gives us a rough image count, then we
 * multiply by the per-image token cost.
 */
function estimateTokensForStrippedImages(base64Chars: number): number {
  if (base64Chars <= 0) return 0
  // Estimate number of images from total base64 chars.
  // A typical screenshot is 150K-300K base64 chars; use 200K as average.
  const estimatedImages = Math.max(1, Math.round(base64Chars / 200_000))
  return estimatedImages * 1_600
}

/**
 * Inflates `input_tokens` in `message_start` and `message_delta` SSE events
 * to account for base64 images that were stripped before sending to Copilot.
 * Mutates the event in-place.
 */
function inflateEventInputTokens(
  event: AnthropicStreamEventData,
  overhead: number,
): void {
  if (event.type === "message_start") {
    event.message.usage.input_tokens += overhead
  }
  if (
    event.type === "message_delta"
    && event.usage?.input_tokens !== undefined
  ) {
    event.usage.input_tokens += overhead
  }
}

async function handleServerSearch(
  c: Context,
  payload: AnthropicMessagesPayload,
  limit: number,
) {
  const run = () =>
    runServerWebSearch(payload, limit, fetchNonStreamingAnthropicResponse)
  if (payload.stream) {
    return streamSSE(c, async (stream) => {
      const stopKeepalive = startSSEKeepalive(stream)
      try {
        await emitAnthropicResponseAsSSE(stream, await run())
      } catch (error) {
        await emitStreamingError(stream, error, payload.model)
      } finally {
        stopKeepalive()
      }
    })
  }
  try {
    return c.json(await run())
  } catch (error) {
    const contextWindowMessage = await extractContextWindowMessage(error)
    if (error instanceof CompactionNeededError || contextWindowMessage) {
      return sendAnthropicContextWindowError(c, contextWindowMessage ?? "", {
        status: 400,
        modelLimit: lookupModelLimit(payload.model),
      })
    }
    throw error
  }
}

const completeOutputTool: OutputCompletion = async (request, requestSignal) => {
  const response = await fetchCopilotResponse(
    { ...request, stream: false },
    requestSignal,
  )
  if (!isNonStreaming(response))
    throw new Error("Expected buffered output response")
  return response
}

async function handleOutputTool(c: Context, payload: AnthropicMessagesPayload) {
  const disconnect = new AbortController()
  const signal = AbortSignal.any([c.req.raw.signal, disconnect.signal])
  const run = () =>
    fetchNonStreamingAnthropicResponse(
      { ...payload, stream: false },
      { signal, complete: completeOutputTool },
    )
  if (payload.stream) {
    return streamSSE(c, async (stream) => {
      const stopKeepalive = startSSEKeepalive(stream)
      stream.onAbort(() => {
        stopKeepalive()
        disconnect.abort(new Error("Client disconnected"))
      })
      try {
        const response = await run()
        signal.throwIfAborted()
        await emitAnthropicResponseAsSSE(stream, response)
      } catch (error) {
        if (!signal.aborted)
          await emitStreamingError(stream, error, payload.model)
      } finally {
        stopKeepalive()
      }
    })
  }
  try {
    return c.json(await run())
  } catch (error) {
    if (error instanceof CompactionNeededError) {
      return sendAnthropicContextWindowError(c, "", {
        status: 400,
        modelLimit: lookupModelLimit(payload.model),
      })
    }
    throw error
  }
}

async function handleNonStreaming(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) {
  if (looksLikeCompactionRequest(anthropicPayload)) {
    return handleNonStreamingCompaction(c, anthropicPayload)
  }

  let result: ImageStrippingResult<
    Awaited<ReturnType<typeof createChatCompletions>>
  >

  try {
    result = await fetchWithImageStripping(
      fetchCopilotResponse,
      anthropicPayload,
    )
  } catch (error) {
    // 413 cascade exhausted — all images stripped, still too large.
    throwIfRequestAborted()
    // Return invalid_request_error to trigger Claude Code auto-compaction.
    // This is safe because images are already gone and compaction will
    // reduce the text content, producing a convergently smaller request.
    if (error instanceof CompactionNeededError) {
      const modelLimit = lookupModelLimit(anthropicPayload.model)
      return sendAnthropicContextWindowError(c, "", {
        status: 400,
        modelLimit,
      })
    }

    // Re-throw non-413 HTTPErrors so they bubble up to the route-level
    // forwardError handler, which returns the raw Copilot error JSON with
    // the original HTTP status code.
    if (error instanceof HTTPError) throw error

    consola.error("Copilot connection error (fetch-level):", error)
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message:
            error instanceof Error ?
              error.message
            : "An unexpected error occurred.",
        },
      },
      500,
    )
  }

  if (!isNonStreaming(result.response)) {
    // Payload said non-streaming but Copilot returned a stream — treat as error.
    consola.error("Expected non-streaming response but got stream")
    return c.json(
      {
        type: "error",
        error: { type: "api_error", message: "Unexpected streaming response." },
      },
      500,
    )
  }

  if (!hasLogicalWriteTool(anthropicPayload)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(result.response).slice(-400),
    )
  }

  // Detect empty non-streaming responses: some models (notably Gemini)
  // return finish_reason "stop" with empty/null content and 0 output tokens.
  // Returning this as a valid response causes Claude Code to see "end_turn"
  // with empty content and stop the session.  Returning overloaded_error would
  // cause Claude Code to retry the exact same request in an infinite loop.
  // Instead, return a synthetic valid response with explanatory text so the
  // conversation can move forward.
  if (isEmptyNonStreamingResponse(result.response)) {
    consola.debug(
      "Empty non-streaming response detected — returning synthetic fallback",
    )
    return c.json(buildSyntheticFallbackJson(anthropicPayload, result.response))
  }

  if (shouldUsePlainTextCompactionFallback(anthropicPayload, result.response)) {
    consola.debug(
      "Non-streaming compaction response lacked usable text — retrying with tools stripped",
    )
    const fallbackResponse = await fetchPlainTextCompactionResponse(
      anthropicPayload,
      result.response,
    )
    result = {
      ...result,
      response: fallbackResponse,
    }
  }

  const toolNameMap = createToolNameMapFromAnthropicPayload(anthropicPayload)
  const anthropicResponse = translateToAnthropic(
    result.response as ChatCompletionResponse,
    toolNameMap,
  )

  // Inflate input_tokens to account for images stripped before sending.
  // Copilot reports prompt_tokens based on the smaller (stripped) payload,
  // but Claude Code uses this value to track context usage and decide when
  // to compact.  Without inflation, it never sees the true cost of images
  // in the conversation and never compacts.
  if (result.strippedBase64Chars > 0) {
    anthropicResponse.usage.input_tokens += estimateTokensForStrippedImages(
      result.strippedBase64Chars,
    )
  }

  if (!hasLogicalWriteTool(anthropicPayload)) {
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
  }
  return c.json(anthropicResponse)
}

/**
 * Handles structured output requests (output_config.format present).
 *
 * Claude Code uses structured output for lightweight tasks like title
 * generation — it sends output_config.format.type = "json_schema" and
 * expects the response text to be valid JSON matching the schema.
 *
 * The Copilot Chat Completions API silently ignores `response_format`, so
 * the model may return free text instead of JSON.  To work around this:
 *
 * 1. Force the upstream request to **non-streaming** so we get the full
 *    response text before committing anything to the client.
 * 2. Validate the response text as JSON.  If invalid, try to extract a
 *    JSON object from the free-text response.
 * 3. If the original Anthropic request was streaming, emit the validated
 *    response as a proper SSE event sequence; otherwise return as JSON.
 */
async function handleStructuredOutput(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) {
  const wasStreaming = anthropicPayload.stream

  // Force non-streaming so we can validate the full response
  const nonStreamingPayload: AnthropicMessagesPayload = {
    ...anthropicPayload,
    stream: false,
  }

  const toolNameMap = createToolNameMapFromAnthropicPayload(nonStreamingPayload)
  const openAIPayload = translateToOpenAI(nonStreamingPayload, toolNameMap)
  consola.debug(
    "Translated OpenAI request payload (structured output):",
    JSON.stringify(openAIPayload),
  )

  const selectedModel = state.models?.data.find(
    (m) => m.id === openAIPayload.model,
  )
  clampMaxTokens(openAIPayload, selectedModel)

  consola.debug(
    `[structured-output] model=${openAIPayload.model} found=${selectedModel !== undefined}`,
  )

  let response: ChatCompletionResponse
  try {
    const result = await createChatCompletions(openAIPayload)
    // Non-streaming should return ChatCompletionResponse directly
    response = result as ChatCompletionResponse
  } catch (error) {
    throwIfRequestAborted()
    consola.error("[structured-output] Upstream fetch failed:", error)
    if (error instanceof HTTPError) throw error
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message:
            error instanceof Error ?
              error.message
            : "Structured output fetch failed.",
        },
      },
      500,
    )
  }

  // Extract the response text
  const rawText = response.choices[0]?.message.content ?? ""

  // Try to validate/repair the JSON
  const repairedText = repairJsonResponse(rawText)
  consola.debug(
    `[structured-output] raw=${JSON.stringify(rawText).slice(0, 200)} repaired=${JSON.stringify(repairedText).slice(0, 200)}`,
  )

  // Replace the response content with the repaired text
  if (response.choices[0]) {
    response.choices[0].message.content = repairedText
  }

  if (wasStreaming) {
    // Emit as SSE event sequence
    return streamSSE(c, async (stream) => {
      await emitNonStreamingAsSSE(stream, response, { toolNameMap })
    })
  }

  // Non-streaming: translate and return
  const anthropicResponse = translateToAnthropic(response, toolNameMap)
  consola.debug(
    "Translated Anthropic response (structured output):",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}

/**
 * Attempts to ensure the response text is valid JSON.
 *
 * When the Copilot API ignores response_format, the model may wrap JSON
 * in markdown code fences, add explanatory text around it, or return
 * entirely free-form text.  This function tries progressively more
 * aggressive extraction strategies:
 *
 * 1. If the text is already valid JSON, return as-is.
 * 2. Strip markdown code fences and try again.
 * 3. Extract the first JSON object literal from the text.
 * 4. If all else fails, return the original text unchanged (Claude Code
 *    will fall back to its default title).
 */
function repairJsonResponse(text: string): string {
  const trimmed = text.trim()

  // 1. Already valid JSON
  if (isValidJson(trimmed)) return trimmed

  // 2. Markdown code fence: ```json ... ``` or ``` ... ```
  // eslint-disable-next-line regexp/no-super-linear-backtracking, regexp/optimal-quantifier-concatenation
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch?.[1] && isValidJson(fenceMatch[1].trim())) {
    return fenceMatch[1].trim()
  }

  // 3. Extract first JSON object from anywhere in the text
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (jsonMatch?.[0] && isValidJson(jsonMatch[0])) {
    return jsonMatch[0]
  }

  // 4. Give up — return original
  return text
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

async function handleNonStreamingCompaction(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) {
  try {
    return c.json(await fetchNonStreamingAnthropicResponse(anthropicPayload))
  } catch (error) {
    if (error instanceof CompactionNeededError) {
      const modelLimit = lookupModelLimit(anthropicPayload.model)
      return sendAnthropicContextWindowError(c, "", {
        status: 400,
        modelLimit,
      })
    }
    if (error instanceof HTTPError) throw error

    consola.error("Copilot connection error (fetch-level):", error)
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message:
            error instanceof Error ?
              error.message
            : "An unexpected error occurred.",
        },
      },
      500,
    )
  }
}

export function looksLikeCompactionRequest(
  payload: AnthropicMessagesPayload,
): boolean {
  const latestUserMessage = [...payload.messages]
    .reverse()
    .find((message) => message.role === "user")

  const fragments: Array<string> = []
  if (latestUserMessage) {
    if (typeof latestUserMessage.content === "string") {
      fragments.push(latestUserMessage.content)
    } else {
      for (const block of latestUserMessage.content) {
        if (block.type === "text") {
          fragments.push(block.text)
        }
      }
    }
  }

  const text = stripSystemReminders(fragments.join("\n")).toLowerCase()

  const looksLikeResumeScaffold =
    containsAny(text, [
      "continue the conversation from where it left off",
      "continue from the latest state above",
      "resume directly",
      "pick up the last task as if the break never happened",
    ])
    && containsAny(text, [
      "this session is being continued from a previous conversation",
      "older context was compacted to fit the model context window",
      "conversation continuation summary:",
    ])

  if (looksLikeResumeScaffold) {
    return false
  }

  if (
    containsAny(text, [
      "<command-name>/compact</command-name>",
      "<command-message>compact</command-message>",
    ])
  ) {
    return true
  }

  const asksToCompactConversation =
    containsAny(text, ["summarize", "summarise", "compact"])
    && containsAny(text, ["conversation", "chat", "session"])

  const asksToGenerateSummary =
    containsAny(text, ["create", "generate", "write"])
    && containsAny(text, [
      "conversation continuation summary",
      "conversation summary",
      "compact summary",
      "summary for continuation",
    ])

  return asksToCompactConversation || asksToGenerateSummary
}

function containsAny(text: string, candidates: Array<string>): boolean {
  return candidates.some((candidate) => text.includes(candidate))
}

/**
 * Strips `<system-reminder>...</system-reminder>` blocks from text.
 *
 * Claude Code injects system-reminder tags into user messages containing
 * skill descriptions, CLAUDE.md content, MCP server instructions, and other
 * metadata.  These injected blocks often contain words like "compact",
 * "summarize", "conversation", "session" that cause false positives in
 * `looksLikeCompactionRequest`.  By stripping them before pattern matching,
 * we only inspect the user's actual message text.
 */
function stripSystemReminders(text: string): string {
  return text.replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
}

function hasUsableNonStreamingText(response: ChatCompletionResponse): boolean {
  if (response.choices.length === 0) return false
  const choice = response.choices[0]
  return (
    typeof choice.message.content === "string"
    && choice.message.content.trim().length > 0
  )
}

export function shouldUsePlainTextCompactionFallback(
  payload: AnthropicMessagesPayload,
  response: ChatCompletionResponse,
): boolean {
  if (!looksLikeCompactionRequest(payload)) return false
  if (!payload.tools || payload.tools.length === 0) return false
  if (response.choices.length === 0) return false

  const choice = response.choices[0]
  return (
    !hasUsableNonStreamingText(response)
    || choice.finish_reason === "tool_calls"
    || (choice.message.tool_calls !== undefined
      && choice.message.tool_calls.length > 0)
  )
}

function buildPlainTextCompactionPayload(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  const systemInstruction =
    "Respond with plain text only. Do not call tools. Produce only the "
    + "requested conversation summary or compaction text."

  let mergedSystem: AnthropicMessagesPayload["system"]
  if (typeof payload.system === "string") {
    mergedSystem = [
      { type: "text", text: payload.system },
      { type: "text", text: systemInstruction },
    ]
  } else if (Array.isArray(payload.system)) {
    mergedSystem = [
      ...payload.system,
      {
        type: "text",
        text: systemInstruction,
      },
    ]
  } else {
    mergedSystem = systemInstruction
  }

  return {
    ...payload,
    system: mergedSystem,
    tools: undefined,
    tool_choice: { type: "none" },
  }
}

function extractCompactionFragments(
  payload: AnthropicMessagesPayload,
): Array<string> {
  const fragments: Array<string> = []

  for (const message of payload.messages.slice(-12)) {
    if (typeof message.content === "string") {
      fragments.push(`[${message.role}] ${message.content}`)
      continue
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        fragments.push(`[${message.role}] ${block.text}`)
      }
    }
  }

  return fragments
}

function clampCompactionFragment(text: string, maxLength: number): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  const headLength = Math.max(80, Math.floor((maxLength - 5) / 2))
  const tailLength = Math.max(40, maxLength - headLength - 5)
  return `${normalized.slice(0, headLength)} ... ${normalized.slice(-tailLength)}`
}

function buildCompactionSummaryText(payload: AnthropicMessagesPayload): string {
  const fragments = extractCompactionFragments(payload)
    .slice(-8)
    .map((fragment) => clampCompactionFragment(fragment, 400))

  return (
    "Conversation continuation summary:\n"
    + fragments.join("\n")
    + "\n\nContinue from the latest state above. Older context was compacted "
    + "to fit the model context window."
  )
}

export function buildSyntheticCompactionResponse(
  payload: AnthropicMessagesPayload,
  usage?: ChatCompletionResponse["usage"],
): ChatCompletionResponse {
  const content = buildCompactionSummaryText(payload)

  return {
    id: `chatcmpl_compact_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: usage ?? {
      prompt_tokens: 0,
      completion_tokens: 1,
      total_tokens: 1,
    },
  }
}

async function fetchNonStreamingAnthropicResponse(
  anthropicPayload: AnthropicMessagesPayload,
  outputRecovery?: { signal: AbortSignal; complete: OutputCompletion },
): Promise<AnthropicResponse> {
  let preparedPayload = anthropicPayload
  const initial = new AbortController()
  const timer =
    outputRecovery ?
      setTimeout(
        () => initial.abort(new Error("Initial output generation timed out")),
        300_000,
      )
    : undefined
  const signal =
    outputRecovery ?
      AbortSignal.any([initial.signal, outputRecovery.signal])
    : undefined
  let result: ImageStrippingResult<
    Awaited<ReturnType<typeof fetchCopilotResponse>>
  >
  try {
    result = await fetchWithImageStripping(async (prepared) => {
      preparedPayload = prepared
      if (outputRecovery && signal)
        return outputRecovery.complete(prepared, signal)
      return fetchCopilotResponse(prepared)
    }, anthropicPayload)
  } finally {
    clearTimeout(timer)
  }

  if (!isNonStreaming(result.response)) {
    throw new Error("Unexpected streaming response.")
  }

  if (!outputRecovery) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(result.response).slice(-400),
    )
  }

  let response = result.response
  if (isEmptyNonStreamingResponse(response)) {
    consola.debug(
      "Empty non-streaming response detected — returning synthetic fallback",
    )
    return buildSyntheticFallbackJson(anthropicPayload, response)
  }

  if (shouldUsePlainTextCompactionFallback(anthropicPayload, response)) {
    consola.debug(
      "Non-streaming compaction response lacked usable text — retrying with tools stripped",
    )
    response = await fetchPlainTextCompactionResponse(
      anthropicPayload,
      response,
    )
  }

  const toolNameMap = createToolNameMapFromAnthropicPayload(anthropicPayload)
  let anthropicResponse: AnthropicResponse
  if (!outputRecovery) {
    anthropicResponse = translateToAnthropic(response, toolNameMap)
  } else if (usesWriteToolRecovery(preparedPayload)) {
    try {
      anthropicResponse = await translateWithWriteRecovery(
        preparedPayload,
        response,
        { map: toolNameMap, ...outputRecovery },
      )
    } catch (error) {
      if (
        !(error instanceof ToolSchemaMismatchError)
        || !usesStructuredOutputRecovery(preparedPayload)
      )
        throw error
      anthropicResponse = await translateWithOutputRecovery(
        preparedPayload,
        response,
        { map: toolNameMap, ...outputRecovery },
      )
    }
  } else {
    anthropicResponse = await translateWithOutputRecovery(
      preparedPayload,
      response,
      { map: toolNameMap, ...outputRecovery },
    )
  }
  if (result.strippedBase64Chars > 0) {
    anthropicResponse.usage.input_tokens += estimateTokensForStrippedImages(
      result.strippedBase64Chars,
    )
  }

  if (!outputRecovery) {
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
  }
  return anthropicResponse
}

async function fetchCompactionResponse(
  anthropicPayload: AnthropicMessagesPayload,
): Promise<{ response: ChatCompletionResponse; strippedBase64Chars: number }> {
  const result = await fetchWithImageStripping(fetchCopilotResponse, {
    ...anthropicPayload,
    stream: false,
  })

  if (!isNonStreaming(result.response)) {
    throw new Error("Unexpected streaming response during compaction.")
  }

  let response = result.response
  if (isEmptyNonStreamingResponse(response)) {
    response = buildSyntheticCompactionResponse(
      anthropicPayload,
      response.usage,
    )
  } else if (shouldUsePlainTextCompactionFallback(anthropicPayload, response)) {
    response = await fetchPlainTextCompactionResponse(
      anthropicPayload,
      response,
    )
  }

  return {
    response,
    strippedBase64Chars: result.strippedBase64Chars,
  }
}

async function fetchPlainTextCompactionResponse(
  payload: AnthropicMessagesPayload,
  originalResponse: ChatCompletionResponse,
): Promise<ChatCompletionResponse> {
  try {
    const fallbackPayload = buildPlainTextCompactionPayload(payload)
    const fallbackResult = await fetchWithImageStripping(
      fetchCopilotResponse,
      fallbackPayload,
    )

    if (!isNonStreaming(fallbackResult.response)) {
      return buildSyntheticCompactionResponse(payload, originalResponse.usage)
    }
    if (isEmptyNonStreamingResponse(fallbackResult.response)) {
      return buildSyntheticCompactionResponse(
        payload,
        fallbackResult.response.usage,
      )
    }
    if (!hasUsableNonStreamingText(fallbackResult.response)) {
      return buildSyntheticCompactionResponse(
        payload,
        fallbackResult.response.usage,
      )
    }
    return fallbackResult.response
  } catch (error) {
    throwIfRequestAborted()
    consola.warn("Plain-text compaction fallback failed:", error)
    return buildSyntheticCompactionResponse(payload, originalResponse.usage)
  }
}

/**
 * Attempts the upstream Copilot fetch with retry logic BEFORE the SSE stream
 * is opened.  Context-window errors and CompactionNeededError propagate to
 * the caller so they can be returned as HTTP-level errors (not SSE events).
 */
async function prefetchCopilotResponse(
  anthropicPayload: AnthropicMessagesPayload,
): Promise<
  ImageStrippingResult<Awaited<ReturnType<typeof fetchCopilotResponse>>>
> {
  let strippingResult:
    | ImageStrippingResult<Awaited<ReturnType<typeof fetchCopilotResponse>>>
    | undefined
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
    try {
      strippingResult = await fetchWithImageStripping(
        fetchCopilotResponse,
        anthropicPayload,
      )
      break
    } catch (error) {
      lastError = error
      // HTTPErrors (including context window 400s) propagate immediately
      if (error instanceof HTTPError) throw error
      // CompactionNeededError propagates immediately
      if (error instanceof CompactionNeededError) throw error
      const isRetriable = isRetriableFetchError(error)
      if (!isRetriable || attempt === MAX_FETCH_RETRIES) throw error
      consola.warn(
        `Copilot fetch attempt ${attempt}/${MAX_FETCH_RETRIES} failed (${error.message}), retrying…`,
      )
    }
  }

  if (!strippingResult) throw lastError
  return strippingResult
}

/**
 * If the error is an HTTPError with a context-window-exceeded message,
 * returns that message string.  Otherwise returns undefined.
 * Reads and clones the response so the body is still available for
 * downstream error handling.
 */
async function extractContextWindowMessage(
  error: unknown,
): Promise<string | undefined> {
  if (!(error instanceof HTTPError)) return undefined
  try {
    const cloned = error.response.clone()
    const text = await cloned.text()
    consola.debug(
      `[context-window] Raw upstream error (status=${error.response.status}): ${text.slice(0, 500)}`,
    )
    if (isContextWindowError(text)) {
      // Try to extract the inner message from JSON
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        const errObj = parsed.error as Record<string, unknown> | undefined
        if (typeof errObj?.message === "string") {
          consola.debug(
            `[context-window] Extracted inner message: ${errObj.message}`,
          )
          return errObj.message
        }
      } catch {
        // not JSON
      }
      return text
    }
    return undefined
  } catch {
    return undefined
  }
}

async function handleStreaming(
  stream: SSEStreamingApi,
  anthropicPayload: AnthropicMessagesPayload,
  strippingResult: ImageStrippingResult<
    Awaited<ReturnType<typeof fetchCopilotResponse>>
  >,
): Promise<void> {
  try {
    const { response: copilotResponse, strippedBase64Chars } = strippingResult
    const imageTokenOverhead =
      estimateTokensForStrippedImages(strippedBase64Chars)
    const toolNameMap = createToolNameMapFromAnthropicPayload(anthropicPayload)

    if (isNonStreaming(copilotResponse)) {
      // Shouldn't happen for a streaming payload, but handle gracefully by
      // emitting a proper Anthropic SSE event sequence from the non-streaming
      // response. Sending just a single "message_start" with the full response
      // body causes Claude Code to miss tool call details entirely.
      consola.debug(
        "Non-streaming response from Copilot (unexpected for streaming request):",
        JSON.stringify(copilotResponse).slice(-400),
      )

      // Detect empty non-streaming response and treat like an empty stream —
      // retry transparently instead of sending empty content to Claude Code.
      if (isEmptyNonStreamingResponse(copilotResponse)) {
        consola.debug(
          "Empty non-streaming response detected in streaming path — retrying",
        )
        const thinkingEnabled = isThinkingRequested(anthropicPayload.thinking)
        await retryEmptyResponse(stream, anthropicPayload, {
          thinkingEnabled,
          imageTokenOverhead,
          toolNameMap,
        })
        return
      }

      await emitNonStreamingAsSSE(stream, copilotResponse, {
        imageTokenOverhead,
        toolNameMap,
      })
      return
    }

    const thinkingEnabled = isThinkingRequested(anthropicPayload.thinking)
    const hadContent = await pipeStreamToClient(stream, copilotResponse, {
      thinkingEnabled,
      imageTokenOverhead,
      toolNameMap,
    })

    // When the model returns an empty response (reasoning completed but no
    // output), retry the request transparently.  Since no message_start was
    // sent to the client, the SSE connection is clean and we can pipe a new
    // response without protocol violations.
    if (!hadContent) {
      await retryEmptyResponse(stream, anthropicPayload, {
        thinkingEnabled,
        imageTokenOverhead,
        toolNameMap,
      })
    }
  } catch (error) {
    // Errors here occur during stream piping (after the initial fetch
    if (requestSignal()?.aborted) return
    // succeeded).  The SSE connection is already committed to HTTP 200,
    // so we can only emit SSE error events — not HTTP-level errors.
    // Context window errors and CompactionNeededError are already handled
    // in handleCompletion (before the SSE stream starts).
    consola.error("Error during stream piping:", error)
    await emitStreamingError(stream, error, anthropicPayload.model)
  }
}

/**
 * Clamps `max_tokens` on the OpenAI payload to the model's actual
 * `max_output_tokens` limit.  This prevents the upstream API from
 * truncating the response mid-tool-call when the client (e.g. Claude Code)
 * requests more output tokens than the model supports.
 *
 * When no `selectedModel` is provided, the function looks up the model
 * from `state.models` by `payload.model`.  Mutates the payload in-place.
 */
function clampMaxTokens(
  payload: import("~/services/copilot/create-chat-completions").ChatCompletionsPayload,
  selectedModel?: import("~/services/copilot/get-models").Model,
): void {
  const model =
    selectedModel
    ?? state.models?.data.find((m) => m.id === payload.model)
    ?? knownModelMetadata(payload.model)

  const modelMaxOutput = model ? getModelMaxOutput(model) : undefined
  if (
    modelMaxOutput
    && payload.max_tokens
    && payload.max_tokens > modelMaxOutput
  ) {
    consola.debug(
      `Clamping max_tokens from ${payload.max_tokens} to model limit ${modelMaxOutput}`,
    )
    payload.max_tokens = modelMaxOutput
  }
}

async function fetchCopilotResponse(
  anthropicPayload: AnthropicMessagesPayload,
  outputSignal?: AbortSignal,
): ReturnType<typeof createChatCompletions> {
  throwIfRequestAborted()
  const openAIPayload = translateToOpenAI(anthropicPayload)
  if (!outputSignal && !hasLogicalWriteTool(anthropicPayload)) {
    consola.debug(
      "Translated OpenAI request payload:",
      JSON.stringify(openAIPayload),
    )
  }

  const selectedModel = state.models?.data.find(
    (m) => m.id === openAIPayload.model,
  )
  clampMaxTokens(openAIPayload, selectedModel)
  applyLargeEditGuidance(
    openAIPayload,
    selectedModel ? getModelMaxOutput(selectedModel) : undefined,
  )
  if (outputSignal) {
    return createOneShotCompletion(
      openAIPayload,
      selectedModel !== undefined && requiresResponsesApi(selectedModel),
      outputSignal,
    )
  }
  consola.debug(
    `[routing] model=${openAIPayload.model} found=${selectedModel !== undefined} requiresResponses=${selectedModel !== undefined && requiresResponsesApi(selectedModel)} endpoints=${JSON.stringify(selectedModel?.supported_endpoints)}`,
  )
  if (selectedModel !== undefined && requiresResponsesApi(selectedModel)) {
    // createResponsesCompletion returns AsyncIterable<SSEMessage> for streaming,
    // which is structurally compatible with AsyncGenerator<ServerSentEventMessage>
    // at runtime — both support for-await-of. Cast to align with the return type.
    return createResponsesCompletion(openAIPayload) as ReturnType<
      typeof createChatCompletions
    >
  }

  return createChatCompletions(openAIPayload)
}

/**
 * Retries the upstream fetch when the model returned an empty response
 * (no content, no tool calls).  Since no `message_start` was sent to the
 * client yet, the SSE connection is clean and we can transparently pipe
 * a fresh response.  After all retries are exhausted, sends an error event.
 */
async function retryEmptyResponse(
  stream: SSEStreamingApi,
  anthropicPayload: AnthropicMessagesPayload,
  ctx: {
    thinkingEnabled: boolean
    imageTokenOverhead: number
    toolNameMap: ToolNameMap
  },
): Promise<void> {
  for (
    let emptyRetry = 1;
    emptyRetry <= MAX_EMPTY_RESPONSE_RETRIES;
    emptyRetry++
  ) {
    consola.debug(
      `Empty response retry ${emptyRetry}/${MAX_EMPTY_RESPONSE_RETRIES}`,
    )
    const retryResult = await fetchWithImageStripping(
      fetchCopilotResponse,
      anthropicPayload,
    )
    const { response: retryResponse } = retryResult

    if (isNonStreaming(retryResponse)) {
      // Non-streaming retry can also be empty — treat as another empty attempt
      // and continue to the next retry rather than emitting empty content.
      if (isEmptyNonStreamingResponse(retryResponse)) {
        consola.debug(
          `Empty non-streaming response on retry ${emptyRetry} — continuing`,
        )
        continue
      }
      await emitNonStreamingAsSSE(stream, retryResponse, {
        imageTokenOverhead: ctx.imageTokenOverhead,
        toolNameMap: ctx.toolNameMap,
      })
      return
    }

    const retryHadContent = await pipeStreamToClient(stream, retryResponse, {
      thinkingEnabled: ctx.thinkingEnabled,
      imageTokenOverhead: ctx.imageTokenOverhead,
      toolNameMap: ctx.toolNameMap,
    })
    if (retryHadContent) return
  }

  // All retries returned empty — the model persistently refuses to generate
  // output for this conversation state.  Sending overloaded_error here would
  // cause Claude Code to retry the exact same (doomed) request in an infinite
  // loop until it gives up and stops the session.  Instead, emit a synthetic
  // valid assistant response.  This allows the conversation to move forward:
  // Claude Code sees the model "said something" and can proceed to the next
  // turn naturally.
  consola.debug(
    "All empty response retries exhausted — emitting synthetic fallback response",
  )
  await emitSyntheticFallbackResponse(stream, anthropicPayload)
}

function logMissingVisibleOutputFinish(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): void {
  if (chunk.choices.length === 0) return
  const choice = chunk.choices[0]
  const hasVisibleText =
    state.hasEmittedText || Boolean(choice.delta.content?.trim())
  const hasToolCalls =
    Object.keys(state.toolCalls).length > 0
    || Boolean(choice.delta.tool_calls?.length)
  const isFiltered = choice.finish_reason === "content_filter"

  if (
    !choice.finish_reason
    || hasVisibleText
    || (hasToolCalls && !isFiltered)
  ) {
    return
  }

  consola.warn("Copilot stream finished without visible output", {
    model: chunk.model,
    finishReason: choice.finish_reason,
    hadThinking:
      state.hasEmittedThinking
      || Boolean(choice.delta.reasoning_content)
      || Boolean(choice.delta.reasoning_text),
    hadToolCalls: hasToolCalls,
    messageStarted: state.messageStartSent,
  })
}

async function closeUpstreamStream(
  response: AsyncGenerator<ServerSentEventMessage, void, unknown>,
): Promise<void> {
  try {
    await response.return(undefined)
  } catch (error) {
    consola.debug("Failed to close upstream stream cleanly:", error)
  }
}

function createAnthropicStreamState(
  thinkingEnabled: boolean,
  toolNameMap: ToolNameMap | undefined,
): AnthropicStreamState {
  return {
    messageStartSent: false,
    messageStopSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    thinkingBlockOpen: false,
    hasEmittedText: false,
    hasEmittedThinking: false,
    toolCalls: {},
    toolNameMap,
    thinkingEnabled,
  }
}

// eslint-disable-next-line complexity
async function pipeStreamToClient(
  stream: SSEStreamingApi,
  response: AsyncGenerator<ServerSentEventMessage, void, unknown>,
  options: {
    thinkingEnabled: boolean
    imageTokenOverhead?: number
    toolNameMap?: ToolNameMap
  },
): Promise<boolean> {
  const { thinkingEnabled, imageTokenOverhead = 0, toolNameMap } = options
  const streamState = createAnthropicStreamState(thinkingEnabled, toolNameMap)

  // Keep pinging for the full lifetime of the upstream stream. A single ping
  // does not protect waits longer than a reverse proxy's idle timeout.
  const stopKeepalive = startSSEKeepalive(stream)
  let upstreamStarted = false
  let upstreamTimedOut = false

  try {
    // Instead of `for await (const rawEvent of response)` which blocks
    // indefinitely when the upstream never closes, we manually iterate with
    // a stall timeout.  This lets us break out and synthesize proper
    // termination events when the Copilot API hangs after a large tool call.
    for (;;) {
      const rawEvent = await nextWithTimeout(
        response,
        streamState,
        upstreamStarted,
      )

      // Timeout or natural end of stream
      if (rawEvent === STREAM_TIMED_OUT) {
        upstreamTimedOut = true
        break
      }
      if (rawEvent === undefined) break

      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      if (chunk.choices.length > 0) upstreamStarted = true
      logMissingVisibleOutputFinish(chunk, streamState)

      // Detect empty responses before sending message_start: some models
      // (notably Gemini) return a single chunk with finish_reason "stop",
      // no content, and no tool calls after completing their reasoning phase.
      // If we haven't sent message_start yet, we can safely signal the
      // caller to retry instead of sending an empty turn to Claude Code.
      if (!streamState.messageStartSent && isEmptyStreamResponse(chunk)) {
        consola.debug(
          "Empty response detected from model — signaling for retry",
        )
        return false
      }

      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        // Inflate input_tokens to account for images stripped before sending.
        if (imageTokenOverhead > 0) {
          inflateEventInputTokens(event, imageTokenOverhead)
        }
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }

      // Once finish_reason has been deferred AND we've consumed the usage
      // chunk (or exhausted the stream), flush the deferred message_delta +
      // message_stop.  We continue reading after the finish_reason chunk to
      // capture the usage-only chunk that arrives with `stream_options`.
      if (streamState.messageStopSent) break
      if (
        streamState.deferredFinishReason !== undefined
        && streamState.lastSeenUsage
      ) {
        await emitDeferredFinish(stream, streamState, imageTokenOverhead)
        break
      }
    }

    // If the stream ended (DONE / timeout) before usage arrived, flush
    // the deferred finish with whatever usage we have (possibly 0).
    if (streamState.deferredFinishReason !== undefined) {
      await emitDeferredFinish(stream, streamState, imageTokenOverhead)
    }

    await handleIncompleteStream(stream, streamState)
  } catch (error) {
    if (requestSignal()?.aborted) return true
    consola.error("Stream error from Copilot:", error)

    if (streamState.contentBlockOpen) {
      await stream.writeSSE({
        event: "content_block_stop",
        data: JSON.stringify({
          type: "content_block_stop",
          index: streamState.contentBlockIndex,
        }),
      })
    }

    const errorMessage =
      error instanceof Error ?
        error.message
      : "An unexpected error occurred during streaming."
    const errorEvent = translateErrorToAnthropicErrorEvent(errorMessage)
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } finally {
    stopKeepalive()
    if (upstreamTimedOut) {
      // A timed-out iter.next() is still pending. Async-generator operations
      // are serialized, so awaiting return() here would queue behind that read
      // and recreate the multi-minute hang the stall guard just recovered from.
      void closeUpstreamStream(response)
    } else {
      await closeUpstreamStream(response)
    }
  }
  return true
}

/**
 * Flushes deferred `message_delta` + `message_stop` events to the SSE stream.
 * Applies image token overhead inflation if needed.
 */
async function emitDeferredFinish(
  stream: SSEStreamingApi,
  streamState: AnthropicStreamState,
  imageTokenOverhead: number,
): Promise<void> {
  const finishEvents = flushDeferredFinish(streamState)
  for (const event of finishEvents) {
    if (imageTokenOverhead > 0) {
      inflateEventInputTokens(event, imageTokenOverhead)
    }
    consola.debug("Deferred finish event:", JSON.stringify(event))
    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event),
    })
  }
}

/**
 * Pulls the next value from an async iterator with a stall timeout.
 *
 * Returns the next yielded value, or `undefined` if either:
 * - The iterator is done (natural end of stream), OR
 * - The iterator has been stalled for STREAM_STALL_TIMEOUT_MS after either
 *   upstream activity or a downstream message_start.
 *
 * The stall timeout is the key fix for the Write tool hang: when the Copilot
 * API finishes streaming a large tool call but never sends `finish_reason`,
 * `response.next()` blocks forever on `reader.read()`.  Racing it against a
 * 90-second timeout lets us break out and synthesize the missing termination
 * events (via handleIncompleteStream).  The downstream stays alive via
 * periodic ping events, so the timeout can be generous enough to accommodate
 * models like Gemini that pause for 60-90s during deep reasoning.
 */
async function nextWithTimeout(
  iter: AsyncGenerator<ServerSentEventMessage, void, unknown>,
  streamState: AnthropicStreamState,
  upstreamStarted: boolean,
): Promise<ServerSentEventMessage | typeof STREAM_TIMED_OUT | undefined> {
  // Before any upstream activity we don't apply a stall timeout — the model's
  // initial response can take a long time and is covered by the ping keepalive
  // plus the upstream inactivity abort. Once even a role preamble arrives, use
  // the normal stall guard without forcing an empty downstream message_start.
  if (!streamState.messageStartSent && !upstreamStarted) {
    const result = await iter.next()
    return result.done ? undefined : result.value
  }

  // Race the next chunk against a stall timeout.
  let timer: ReturnType<typeof setTimeout> | undefined
  const stallTimeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), STREAM_STALL_TIMEOUT_MS)
  })
  const result = await Promise.race([iter.next(), stallTimeout]).finally(() => {
    clearTimeout(timer)
  })

  if (result === "timeout") {
    consola.debug(
      `Upstream stream stalled for ${STREAM_STALL_TIMEOUT_MS / 1000}s after `
        + `stream activity — synthesizing termination events`,
    )
    return STREAM_TIMED_OUT
  }

  return result.done ? undefined : result.value
}

/**
 * Handles the case where the upstream stream ended without a proper Anthropic
 * termination sequence (message_delta + message_stop).
 *
 * Two scenarios:
 * 1. Stream never produced any content → emit a synthetic error event.
 * 2. Stream started (message_start sent) but ended without finish_reason →
 *    synthesize the missing termination events so Claude Code can proceed.
 */
export async function handleIncompleteStream(
  stream: SSEStreamingApi,
  state: AnthropicStreamState,
): Promise<void> {
  if (!state.messageStartSent) {
    // No usable chunks arrived at all.
    consola.debug(
      "Copilot stream ended without producing any content — emitting error event",
    )
    const errorEvent = translateErrorToAnthropicErrorEvent(
      "The model returned an empty response. This may indicate the model is unavailable or does not support this request.",
    )
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
    return
  }

  if (state.messageStopSent) {
    return // Stream ended normally, nothing to do.
  }

  if (Object.keys(state.toolCalls).length > 0) {
    const error = translateErrorToAnthropicErrorEvent(
      "The upstream stream ended before tool generation completed. No tool call was committed; retry the request.",
    )
    state.messageStopSent = true
    await stream.writeSSE({ event: error.type, data: JSON.stringify(error) })
    return
  }

  // The upstream stream started but ended without a chunk containing
  // finish_reason — no message_delta / message_stop was ever sent.
  // Some models (notably Gemini) can terminate the stream abruptly after
  // emitting content or tool-call chunks.  Without a proper termination
  // sequence Claude Code sees the SSE connection close with no indication
  // of completion and treats the turn as abandoned / silently dead.
  consola.debug(
    "Copilot stream ended without finish_reason — synthesizing message_delta/message_stop",
  )

  let nextContentBlockIndex = state.contentBlockIndex
  if (state.contentBlockOpen) {
    await stream.writeSSE({
      event: "content_block_stop",
      data: JSON.stringify({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      }),
    })
    nextContentBlockIndex++
  }

  if (!state.hasEmittedText) {
    await emitIncompleteVisibleFallback(stream, state, nextContentBlockIndex)
  }

  await stream.writeSSE({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    }),
  })
  await stream.writeSSE({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  })
}

async function emitIncompleteVisibleFallback(
  stream: SSEStreamingApi,
  state: AnthropicStreamState,
  index: number,
): Promise<void> {
  consola.warn("Copilot stream ended without visible output", {
    hadThinking: state.hasEmittedThinking,
  })
  await emitRecoveryTextBlock(
    stream,
    index,
    (state.pendingLeadingText ?? "") + EMPTY_VISIBLE_OUTPUT_TEXT,
  )
}

async function emitRecoveryTextBlock(
  stream: SSEStreamingApi,
  index: number,
  text: string,
): Promise<void> {
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }),
  })
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    }),
  })
  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index }),
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

/**
 * Detects whether a non-streaming response is effectively empty.
 *
 * Some models (notably Gemini) return finish_reason "stop" with empty or null
 * content and 0 completion tokens after their reasoning phase completes without
 * producing output.  Without this guard, the empty response gets translated to
 * a valid Anthropic message with stop_reason "end_turn" and empty content,
 * causing Claude Code to treat the model's turn as complete and stop the session.
 */
export function isEmptyNonStreamingResponse(
  response: ChatCompletionResponse,
): boolean {
  // No choices at all: upstream produced nothing usable. Treat as empty so
  // the caller emits the synthetic fallback instead of a degenerate
  // { content: [], stop_reason: null } body.
  if (response.choices.length === 0) return true
  const choice = response.choices[0]
  // A normal completed turn finishes with "stop". Anything that finished with
  // a real reason other than "stop" (tool_calls/length/content_filter) is not
  // "empty" — let the normal translation path handle it.
  //
  // The remaining cases we DO treat as empty: finish_reason === "stop" with no
  // content, and finish_reason null/undefined (a degenerate shape some models
  // emit via Copilot) with no content. Both would otherwise translate to an
  // empty content array, which Anthropic clients reject.
  //
  // ChoiceNonStreaming types finish_reason as non-null, but Copilot violates
  // that at runtime (the bug this guard exists for), so widen the type to
  // include the nullish shapes we actually observe before comparing.
  const finishReason = choice.finish_reason as
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter"
    | null
    | undefined
  if (
    finishReason !== "stop"
    && finishReason !== null
    && finishReason !== undefined
  ) {
    return false
  }
  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    return false
  }
  // Content is empty if null, undefined, or empty string
  const content = choice.message.content
  return !content || content.trim() === ""
}

/**
 * Maps an HTTP status code to the corresponding Anthropic error type.
 * Claude Code uses the error type to decide whether a request can be retried.
 */
function mapStatusToAnthropicErrorType(status: number): string {
  if (status === 429) return "rate_limit_error"
  if (status >= 400 && status < 500) return "invalid_request_error"
  if (status >= 500) return "api_error"
  return "api_error"
}

/**
 * Emits an SSE error event for a streaming request.
 *
 * Generally uses "api_error" to prevent Claude Code from retrying in a loop
 * (the HTTP response is already committed to status 200).  However, when the
 * upstream explicitly says the input exceeds the model's context window, we
 * use "invalid_request_error" so Claude Code triggers auto-compaction —
 * compaction reduces the conversation context, which fixes the root cause.
 */
async function emitStreamingError(
  stream: SSEStreamingApi,
  error: unknown,
  modelId?: string,
): Promise<void> {
  if (requestSignal()?.aborted) return
  const { errorMessage, errorType } = await extractStreamingErrorDetails(error)

  const contextWindowError = isContextWindowError(errorMessage)
  const effectiveErrorType =
    contextWindowError ? "invalid_request_error" : errorType
  const modelLimit = modelId ? lookupModelLimit(modelId) : undefined
  const effectiveMessage =
    contextWindowError ?
      formatAnthropicContextWindowError(errorMessage, modelLimit)
    : errorMessage

  const errorEvent = translateErrorToAnthropicErrorEvent(
    effectiveMessage,
    effectiveErrorType,
  )
  await stream.writeSSE({
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  })
}

/**
 * Extracts a meaningful error message and Anthropic-compatible error type
 * from a Copilot error.  For HTTPErrors this reads the response body to
 * get the Copilot-provided message; for network errors it falls back to
 * the generic Error message.
 */
async function extractStreamingErrorDetails(error: unknown): Promise<{
  errorMessage: string
  errorType: string
}> {
  if (error instanceof HTTPError) {
    const errorType = mapStatusToAnthropicErrorType(error.response.status)
    try {
      const cloned = error.response.clone()
      const text = await cloned.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text) as Record<string, unknown>
      } catch {
        parsed = null
      }
      return {
        errorMessage: extractUpstreamErrorMessage(
          parsed,
          text,
          error.response.headers.get("content-type"),
        ),
        errorType,
      }
    } catch {
      return { errorMessage: error.message, errorType }
    }
  }

  return {
    errorMessage:
      error instanceof Error ?
        error.message
      : "An unexpected error occurred during streaming.",
    errorType: "api_error",
  }
}

/**
 * Emits a proper Anthropic SSE event sequence from a non-streaming Copilot
 * response. This is needed when Copilot unexpectedly returns a non-streaming
 * body for a streaming request — sending the full response as a single
 * "message_start" event causes Claude Code to miss all tool call input details.
 */
type EmitNonStreamingAsSSEOptions = {
  imageTokenOverhead?: number
  toolNameMap?: ToolNameMap
}

async function emitNonStreamingAsSSE(
  stream: SSEStreamingApi,
  response: ChatCompletionResponse,
  { imageTokenOverhead = 0, toolNameMap }: EmitNonStreamingAsSSEOptions = {},
): Promise<void> {
  const anthropicResponse = translateToAnthropic(response, toolNameMap)
  return emitAnthropicResponseAsSSE(
    stream,
    anthropicResponse,
    imageTokenOverhead,
  )
}

// eslint-disable-next-line max-lines-per-function -- One ordered emitter handles every Anthropic block without reordering.
async function emitAnthropicResponseAsSSE(
  stream: SSEStreamingApi,
  anthropicResponse: AnthropicResponse,
  imageTokenOverhead = 0,
): Promise<void> {
  // 1. message_start (without content, stop_reason, stop_sequence)
  await stream.writeSSE({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id: anthropicResponse.id,
        type: "message",
        role: "assistant",
        content: [],
        model: anthropicResponse.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens:
            anthropicResponse.usage.input_tokens + imageTokenOverhead,
          output_tokens: 0,
          ...(anthropicResponse.usage.cache_read_input_tokens !== undefined && {
            cache_read_input_tokens:
              anthropicResponse.usage.cache_read_input_tokens,
          }),
        },
      },
    }),
  })

  // 2. Emit each content block as start + delta + stop
  for (let i = 0; i < anthropicResponse.content.length; i++) {
    const block = anthropicResponse.content[i]
    const blockIndex = i

    if (block.type === "text") {
      await stream.writeSSE({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: blockIndex,
          content_block: { ...block, text: "" },
        }),
      })
      await stream.writeSSE({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: block.text },
        }),
      })
    } else if (block.type === "tool_use") {
      await stream.writeSSE({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            ...(block.toolset_name ? { toolset_name: block.toolset_name } : {}),
            input: {},
          },
        }),
      })
      const inputJson = JSON.stringify(block.input)
      await stream.writeSSE({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: inputJson },
        }),
      })
    } else {
      await stream.writeSSE({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: blockIndex,
          content_block: block,
        }),
      })
    }

    await stream.writeSSE({
      event: "content_block_stop",
      data: JSON.stringify({ type: "content_block_stop", index: blockIndex }),
    })
  }

  // 3. message_delta + message_stop
  await stream.writeSSE({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: anthropicResponse.stop_reason,
        stop_sequence: anthropicResponse.stop_sequence,
      },
      usage: {
        output_tokens: anthropicResponse.usage.output_tokens,
      },
    }),
  })
  await stream.writeSSE({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  })
}

// -- Synthetic fallback for persistent empty responses -----------------------
//
// When a model (notably Gemini) persistently returns empty output for a given
// conversation state, retrying the same request is futile.  Returning an error
// (overloaded_error) causes Claude Code to retry the same doomed request in
// an infinite loop until it exhausts its retry budget and stops the session.
//
// The solution: emit a *valid* assistant response with text explaining that the
// model produced no output.  This is saved to conversation history and allows
// Claude Code to proceed — it will see the assistant's "turn" is complete and
// can issue the next turn (which has a different conversation state and often
// succeeds).

const FALLBACK_TEXT =
  "I apologize, but I was unable to generate a response for this turn. "
  + "Let me try a different approach."

/**
 * Emits a synthetic Anthropic SSE event sequence that represents a valid
 * assistant message containing a fallback text.  This unblocks the
 * conversation so Claude Code can proceed to the next turn.
 */
async function emitSyntheticFallbackResponse(
  stream: SSEStreamingApi,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<void> {
  const msgId = `msg_fallback_${Date.now()}`
  const model = anthropicPayload.model

  await stream.writeSSE({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  })
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  })
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: FALLBACK_TEXT },
    }),
  })
  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index: 0 }),
  })
  await stream.writeSSE({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
  })
  await stream.writeSSE({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  })
}

/**
 * Builds a non-streaming Anthropic JSON response with fallback text.
 * Used by the non-streaming handler when the model returns empty.
 */
function buildSyntheticFallbackJson(
  anthropicPayload: AnthropicMessagesPayload,
  response: ChatCompletionResponse,
): import("./anthropic-types").AnthropicResponse {
  return {
    id: toAnthropicMessageId(response.id),
    type: "message",
    role: "assistant",
    model: anthropicPayload.model,
    content: [{ type: "text", text: FALLBACK_TEXT }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: 1,
    },
  }
}
