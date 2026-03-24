import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkBurstLimit, checkRateLimit } from "~/lib/rate-limit"
import { isWebSearchEnabled, state } from "~/lib/state"
import {
  createChatCompletions,
  createResponsesCompletion,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { requiresResponsesApi } from "~/services/copilot/responses-translation"
import {
  prepareWebSearchPayload,
  webSearchInterceptor,
} from "~/services/web-search/interceptor"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  CompactionNeededError,
  fetchWithImageStripping,
  type ImageStrippingResult,
  updateImageFlag,
} from "./image-stripping"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  findTruncatedToolCalls,
  isEmptyStreamResponse,
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"
import { toAnthropicMessageId } from "./utils"
import {
  detectWebSearchIntent,
  stripWebSearchTypedTools,
} from "./web-search-detection"

// Interval at which SSE ping events are sent to keep the downstream
// connection alive while waiting for Copilot to start responding or
// between chunks during slow generation (e.g. large file writes).
// Must be shorter than both the network's TCP idle timeout (~5 min on
// enterprise firewalls) and Claude Code's stream inactivity detector
// (~45s).  10 seconds gives comfortable headroom for both.
const PING_INTERVAL_MS = 10_000

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

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)
  await checkBurstLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Check if compaction has removed images from this session's conversation.
  // This clears the per-session image-stripped flag so count_tokens stops
  // returning the inflated 200K value for this session.
  updateImageFlag(anthropicPayload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  // NOTE: We intentionally do NOT pre-flight reject requests based on local
  // token estimation.  Returning an Anthropic-formatted "invalid_request_error"
  // causes Claude Code to auto-compact and retry in a loop — each retry adds
  // more context, making the prompt even larger.  Instead we let the request
  // through to Copilot and rely on forwardError to return the raw Copilot
  // error JSON (not Anthropic format), which Claude Code won't retry.

  // For non-streaming requests just fetch and translate synchronously —
  // no SSE connection needed, so no ping mechanism required.
  if (!anthropicPayload.stream) {
    return handleNonStreaming(c, anthropicPayload)
  }

  // For streaming requests open the SSE connection to the client first,
  // then fetch from Copilot inside the stream callback. This lets us send
  // periodic ping events while Copilot is thinking, preventing the
  // downstream TCP connection from being killed by enterprise firewalls
  // that drop idle connections after ~5 minutes.
  return streamSSE(c, (stream) => handleStreaming(stream, anthropicPayload))
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

async function handleNonStreaming(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) {
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
    // Return invalid_request_error to trigger Claude Code auto-compaction.
    // This is safe because images are already gone and compaction will
    // reduce the text content, producing a convergently smaller request.
    if (error instanceof CompactionNeededError) {
      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "Request too large. Conversation context exceeds model limit.",
          },
        },
        413,
      )
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

  consola.debug(
    "Non-streaming response from Copilot:",
    JSON.stringify(result.response).slice(-400),
  )

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

  const anthropicResponse = translateToAnthropic(result.response)

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

  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}

// eslint-disable-next-line max-lines-per-function
async function handleStreaming(
  stream: SSEStreamingApi,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<void> {
  // Start pinging every PING_INTERVAL_MS so the downstream TCP connection
  // stays alive while we wait for Copilot to begin responding.
  let pingTimer: ReturnType<typeof setInterval> | undefined = setInterval(
    () => {
      consola.debug("Sending SSE ping to keep connection alive")
      stream
        .writeSSE({ event: "ping", data: JSON.stringify({ type: "ping" }) })
        .catch(() => {
          // Client disconnected — clear the timer; the stream will close naturally.
          clearInterval(pingTimer)
          pingTimer = undefined
        })
    },
    PING_INTERVAL_MS,
  )

  try {
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
        if (error instanceof HTTPError) throw error
        const isRetriable =
          error instanceof Error && RETRIABLE_ERROR_NAMES.has(error.name)
        if (!isRetriable || attempt === MAX_FETCH_RETRIES) throw error
        consola.warn(
          `Copilot fetch attempt ${attempt}/${MAX_FETCH_RETRIES} failed (${error.message}), retrying…`,
        )
      }
    }

    if (!strippingResult) throw lastError

    clearInterval(pingTimer)
    pingTimer = undefined

    const { response: copilotResponse, strippedBase64Chars } = strippingResult
    const imageTokenOverhead =
      estimateTokensForStrippedImages(strippedBase64Chars)

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
        const thinkingEnabled = anthropicPayload.thinking?.type === "enabled"
        await retryEmptyResponse(stream, anthropicPayload, {
          thinkingEnabled,
          imageTokenOverhead,
        })
        return
      }

      await emitNonStreamingAsSSE(stream, copilotResponse, imageTokenOverhead)
      return
    }

    const thinkingEnabled = anthropicPayload.thinking?.type === "enabled"
    const hadContent = await pipeStreamToClient(stream, copilotResponse, {
      thinkingEnabled,
      imageTokenOverhead,
    })

    // When the model returns an empty response (reasoning completed but no
    // output), retry the request transparently.  Since no message_start was
    // sent to the client, the SSE connection is clean and we can pipe a new
    // response without protocol violations.
    if (!hadContent) {
      await retryEmptyResponse(stream, anthropicPayload, {
        thinkingEnabled,
        imageTokenOverhead,
      })
    }
  } catch (error) {
    clearInterval(pingTimer)
    pingTimer = undefined

    // 413 cascade exhausted — all images stripped, still too large.
    // Emit invalid_request_error to trigger Claude Code auto-compaction.
    if (error instanceof CompactionNeededError) {
      const errorEvent = translateErrorToAnthropicErrorEvent(
        "Request too large. Conversation context exceeds model limit.",
        "invalid_request_error",
      )
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
      return
    }

    if (error instanceof HTTPError) {
      consola.error("Copilot HTTP error during streaming fetch:", error)
    } else {
      consola.error("Copilot connection error (fetch-level):", error)
    }

    // Extract the actual error message so Claude Code gets useful diagnostics,
    // but ALWAYS use "api_error" as the type in SSE streams.  The HTTP response
    // is already committed to status 200; sending "invalid_request_error" would
    // trick Claude Code into thinking it can fix the request (e.g. by truncating)
    // and retrying in a loop — each retry adds more context, making the prompt
    // even larger.
    const { errorMessage } = await extractStreamingErrorDetails(error)

    const errorEvent = translateErrorToAnthropicErrorEvent(errorMessage)
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
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
    selectedModel ?? state.models?.data.find((m) => m.id === payload.model)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- some models lack capabilities at runtime
  const modelMaxOutput = model?.capabilities?.limits?.max_output_tokens
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
): ReturnType<typeof createChatCompletions> {
  if (isWebSearchEnabled() && (await detectWebSearchIntent(anthropicPayload))) {
    const cleanedPayload = stripWebSearchTypedTools(anthropicPayload)
    const openAIPayload = prepareWebSearchPayload(
      translateToOpenAI(cleanedPayload),
    )
    clampMaxTokens(openAIPayload)
    consola.debug(
      "Translated OpenAI request payload (web search):",
      JSON.stringify(openAIPayload),
    )
    return webSearchInterceptor(openAIPayload)
  }

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const selectedModel = state.models?.data.find(
    (m) => m.id === openAIPayload.model,
  )
  clampMaxTokens(openAIPayload, selectedModel)
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
  ctx: { thinkingEnabled: boolean; imageTokenOverhead: number },
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
      await emitNonStreamingAsSSE(stream, retryResponse, ctx.imageTokenOverhead)
      return
    }

    const retryHadContent = await pipeStreamToClient(stream, retryResponse, {
      thinkingEnabled: ctx.thinkingEnabled,
      imageTokenOverhead: ctx.imageTokenOverhead,
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

async function pipeStreamToClient(
  stream: SSEStreamingApi,
  response: AsyncGenerator<ServerSentEventMessage, void, unknown>,
  options: { thinkingEnabled: boolean; imageTokenOverhead?: number },
): Promise<boolean> {
  const { thinkingEnabled, imageTokenOverhead = 0 } = options
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    messageStopSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    thinkingBlockOpen: false,
    hasEmittedText: false,
    toolCalls: {},
    thinkingEnabled,
  }

  // Ping while waiting between chunks to keep the connection alive.
  const schedulePing = () =>
    setTimeout(() => {
      consola.debug("Sending SSE ping between chunks")
      stream
        .writeSSE({ event: "ping", data: JSON.stringify({ type: "ping" }) })
        .catch(() => {})
    }, PING_INTERVAL_MS)

  let chunkTimer: ReturnType<typeof setTimeout> | undefined = schedulePing()

  try {
    // Instead of `for await (const rawEvent of response)` which blocks
    // indefinitely when the upstream never closes, we manually iterate with
    // a stall timeout.  This lets us break out and synthesize proper
    // termination events when the Copilot API hangs after a large tool call.
    for (;;) {
      clearTimeout(chunkTimer)
      chunkTimer = schedulePing()

      const rawEvent = await nextWithTimeout(response, streamState)

      // Timeout or natural end of stream
      if (rawEvent === undefined) break

      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

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

      // Once message_stop has been sent, all content is delivered to the client.
      // Break immediately instead of waiting for [DONE] — the upstream Copilot
      // API may keep the HTTP connection open after the last content chunk.
      if (streamState.messageStopSent) break
    }

    await handleIncompleteStream(stream, streamState)
  } catch (error) {
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
    clearTimeout(chunkTimer)
  }
  return true
}

/**
 * Pulls the next value from an async iterator with a stall timeout.
 *
 * Returns the next yielded value, or `undefined` if either:
 * - The iterator is done (natural end of stream), OR
 * - The iterator has been stalled for STREAM_STALL_TIMEOUT_MS while the
 *   stream has already started (messageStartSent === true).
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
): Promise<ServerSentEventMessage | undefined> {
  // Before the stream has started we don't apply a stall timeout —
  // the initial response from Copilot can take a long time (model
  // thinking) and is covered by the ping keepalive + upstream inactivity
  // abort instead.
  if (!streamState.messageStartSent) {
    const result = await iter.next()
    return result.done ? undefined : result.value
  }

  // Race the next chunk against a stall timeout.
  const stallTimeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), STREAM_STALL_TIMEOUT_MS),
  )

  const result = await Promise.race([iter.next(), stallTimeout])

  if (result === "timeout") {
    consola.debug(
      `Upstream stream stalled for ${STREAM_STALL_TIMEOUT_MS / 1000}s after `
        + `message_start — synthesizing termination events`,
    )
    return undefined
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
async function handleIncompleteStream(
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

  // The upstream stream started but ended without a chunk containing
  // finish_reason — no message_delta / message_stop was ever sent.
  // Some models (notably Gemini) can terminate the stream abruptly after
  // emitting content or tool-call chunks.  Without a proper termination
  // sequence Claude Code sees the SSE connection close with no indication
  // of completion and treats the turn as abandoned / silently dead.
  consola.debug(
    "Copilot stream ended without finish_reason — synthesizing message_delta/message_stop",
  )

  if (state.contentBlockOpen) {
    await stream.writeSSE({
      event: "content_block_stop",
      data: JSON.stringify({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      }),
    })
  }

  // Check if any tool calls have truncated (invalid) JSON arguments.
  // This happens when the output token limit was hit mid-tool-call — the
  // accumulated argument fragments don't form valid JSON.  In this case,
  // emit an explanatory text block and use "end_turn" instead of "tool_use"
  // so Claude Code reads the feedback instead of executing a broken tool.
  const hasToolCalls = Object.keys(state.toolCalls).length > 0
  const truncated = hasToolCalls ? findTruncatedToolCalls(state) : []

  if (truncated.length > 0) {
    const toolName = truncated[0].name
    consola.debug(
      `Truncated tool call "${toolName}" detected during stream recovery`,
    )
    const nextIndex = state.contentBlockIndex + 1
    await stream.writeSSE({
      event: "content_block_start",
      data: JSON.stringify({
        type: "content_block_start",
        index: nextIndex,
        content_block: { type: "text", text: "" },
      }),
    })
    await stream.writeSSE({
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: nextIndex,
        delta: {
          type: "text_delta",
          text:
            `[Output truncated: the model's response was cut off while generating`
            + ` tool call "${toolName}". The output exceeded the token limit.`
            + ` Please retry with a smaller output, e.g. write the file in smaller chunks.]`,
        },
      }),
    })
    await stream.writeSSE({
      event: "content_block_stop",
      data: JSON.stringify({ type: "content_block_stop", index: nextIndex }),
    })
  }

  // Use "end_turn" when tool calls are truncated to prevent Claude Code
  // from trying to execute broken tool calls.  Use "tool_use" only when
  // tool calls have valid (non-truncated) JSON arguments.
  let stopReason: string = "end_turn"
  if (hasToolCalls && truncated.length === 0) {
    stopReason = "tool_use"
  }

  await stream.writeSSE({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: stopReason,
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
function isEmptyNonStreamingResponse(
  response: ChatCompletionResponse,
): boolean {
  if (response.choices.length === 0) return false
  const choice = response.choices[0]
  if (choice.finish_reason !== "stop") return false
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
      const parsed = JSON.parse(text) as Record<string, unknown>
      const errorObj = parsed.error as Record<string, unknown> | undefined
      if (typeof errorObj?.message === "string") {
        return { errorMessage: errorObj.message, errorType }
      }
      return { errorMessage: text.slice(0, 200), errorType }
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
async function emitNonStreamingAsSSE(
  stream: SSEStreamingApi,
  response: ChatCompletionResponse,
  imageTokenOverhead: number = 0,
): Promise<void> {
  const anthropicResponse = translateToAnthropic(response)

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
          content_block: { type: "text", text: "" },
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
            input: {},
          },
        }),
      })
      const inputJson = JSON.stringify(block.input)
      if (inputJson !== "{}") {
        await stream.writeSSE({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: inputJson },
          }),
        })
      }
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
