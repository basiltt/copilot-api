import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkBurstLimit, checkRateLimit } from "~/lib/rate-limit"
import { isWebSearchEnabled, state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
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
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"
import {
  detectWebSearchIntent,
  stripWebSearchTypedTools,
} from "./web-search-detection"

// Interval at which SSE ping events are sent to keep the downstream
// connection alive while waiting for Copilot to start responding.
// Must be shorter than the network's TCP idle timeout (~5 min on enterprise
// firewalls). 20 seconds gives comfortable headroom.
const PING_INTERVAL_MS = 20_000

// Maximum number of times to retry a timed-out upstream fetch before giving up.
// Each attempt gets a fresh TCP connection, resetting the firewall idle timer.
// Retry is safe because we only retry before the first byte arrives — if Copilot
// hasn't started generating yet, the request is idempotent.
const MAX_FETCH_RETRIES = 3

// Error name/code patterns that indicate a retriable network failure
// (firewall idle timeout, connection reset) vs. a non-retriable one (4xx, auth).
const RETRIABLE_ERROR_NAMES = new Set([
  "TimeoutError",
  "ECONNRESET",
  "FailedToOpenSocket",
  "ConnectionRefused",
])

// Ratio of Copilot's real token count to our local tokenizer's estimate.
// Our local tokenizer (o200k_base) systematically OVERestimates compared to
// Copilot's tokenizer — a local count of ~190K maps to ~168K on Copilot
// (ratio ≈ 0.88).  We divide the model's max_prompt_tokens by this ratio
// to get the effective local-token limit that corresponds to the real limit.
const LOCAL_TOKENIZER_OVERESTIMATE_RATIO = 0.88

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)
  await checkBurstLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Pre-flight token check: estimate the prompt size and reject early if it
  // would exceed Copilot's max_prompt_tokens.  Claude Code doesn't call
  // count_tokens before every request, so it can send prompts that Copilot
  // will reject.  By checking here we avoid a wasted round trip (which can
  // take minutes for large payloads) and return a clear error immediately.
  const promptLimitError = await checkPromptTokenLimit(c, anthropicPayload)
  if (promptLimitError) return promptLimitError

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

async function handleNonStreaming(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) {
  let response: Awaited<ReturnType<typeof createChatCompletions>>

  try {
    response = await fetchCopilotResponse(anthropicPayload)
  } catch (error) {
    // Re-throw HTTPErrors so they bubble up to the route-level forwardError
    // handler, which returns the raw Copilot error JSON with the original
    // HTTP status code.  Returning an Anthropic-formatted error with type
    // "invalid_request_error" causes Claude Code to auto-compact and retry
    // in a loop when the prompt exceeds Copilot's token limit — each retry
    // adds more context, making the prompt even larger.
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

  if (!isNonStreaming(response)) {
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
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateToAnthropic(response)
  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}

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
    let copilotResponse:
      | Awaited<ReturnType<typeof fetchCopilotResponse>>
      | undefined
    let lastError: unknown

    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      try {
        copilotResponse = await fetchCopilotResponse(anthropicPayload)
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

    if (!copilotResponse) throw lastError

    clearInterval(pingTimer)
    pingTimer = undefined

    if (isNonStreaming(copilotResponse)) {
      // Shouldn't happen for a streaming payload, but handle gracefully by
      // emitting a proper Anthropic SSE event sequence from the non-streaming
      // response. Sending just a single "message_start" with the full response
      // body causes Claude Code to miss tool call details entirely.
      consola.debug(
        "Non-streaming response from Copilot (unexpected for streaming request):",
        JSON.stringify(copilotResponse).slice(-400),
      )
      await emitNonStreamingAsSSE(stream, copilotResponse)
      return
    }

    const thinkingEnabled = anthropicPayload.thinking?.type === "enabled"
    await pipeStreamToClient(stream, copilotResponse, thinkingEnabled)
  } catch (error) {
    clearInterval(pingTimer)
    pingTimer = undefined

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

async function fetchCopilotResponse(
  anthropicPayload: AnthropicMessagesPayload,
): ReturnType<typeof createChatCompletions> {
  if (isWebSearchEnabled() && (await detectWebSearchIntent(anthropicPayload))) {
    const cleanedPayload = stripWebSearchTypedTools(anthropicPayload)
    const openAIPayload = prepareWebSearchPayload(
      translateToOpenAI(cleanedPayload),
    )
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

async function pipeStreamToClient(
  stream: SSEStreamingApi,
  response: AsyncGenerator<ServerSentEventMessage, void, unknown>,
  thinkingEnabled: boolean,
): Promise<void> {
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
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
    for await (const rawEvent of response) {
      clearTimeout(chunkTimer)
      chunkTimer = schedulePing()

      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
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
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

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
 * Quick pre-flight check that estimates the prompt token count and returns
 * an Anthropic-formatted error response if it would exceed Copilot's
 * max_prompt_tokens for the requested model.
 *
 * Returns `undefined` when the request is within limits (or when the model
 * metadata isn't available), signalling the caller to proceed normally.
 */
async function checkPromptTokenLimit(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<Response | undefined> {
  const selectedModel = state.models?.data.find(
    (m) => m.id === anthropicPayload.model,
  )
  if (!selectedModel) return undefined

  const maxPromptTokens = selectedModel.capabilities.limits.max_prompt_tokens
  consola.debug(
    `[pre-flight] model=${anthropicPayload.model} max_prompt_tokens=${maxPromptTokens}`,
  )
  if (!maxPromptTokens) return undefined

  try {
    const openAIPayload = translateToOpenAI(anthropicPayload)
    const tokenCount = await getTokenCount(openAIPayload, selectedModel)
    const estimatedTokens = tokenCount.input + tokenCount.output

    // Our local tokenizer systematically OVERestimates Copilot's count by
    // ~12 %.  Convert the model's real limit into local-tokenizer space so
    // we only reject requests that would truly exceed Copilot's limit.
    // e.g. 168 000 / 0.88 ≈ 190 909 local tokens → ~168K on Copilot.
    const effectiveLimit = Math.floor(
      maxPromptTokens / LOCAL_TOKENIZER_OVERESTIMATE_RATIO,
    )

    if (estimatedTokens > effectiveLimit) {
      const message = `prompt token count of ${estimatedTokens} exceeds the limit of ${maxPromptTokens}`
      consola.warn(
        `Pre-flight token check: ${message} (effective limit: ${effectiveLimit})`,
      )

      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message,
          },
        },
        400,
      )
    }
  } catch (error) {
    // Non-critical — if estimation fails just let the request through and let
    // Copilot be the final arbiter.
    consola.debug("Pre-flight token check skipped (estimation error):", error)
  }

  return undefined
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
          input_tokens: anthropicResponse.usage.input_tokens,
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
