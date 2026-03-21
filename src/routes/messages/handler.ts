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

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)
  await checkBurstLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  if (state.manualApprove) {
    await awaitApproval()
  }

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
      await emitNonStreamingAsSSE(
        stream,
        copilotResponse,
        anthropicPayload.thinking?.type === "enabled",
      )
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

    const errorEvent = translateErrorToAnthropicErrorEvent()
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
    thinkingBlockEmitted: false,
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

    const errorEvent = translateErrorToAnthropicErrorEvent()
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
 * Emits a synthetic thinking content block (start → delta → stop) on the SSE
 * stream.  Claude Code uses thinking blocks for its progress/status UI; since
 * Copilot never returns them, we synthesize an empty one when the original
 * request had thinking enabled.
 *
 * Returns the number of blocks emitted (0 or 1), to be used as an index offset
 * for subsequent content blocks.
 */
async function emitSyntheticThinkingBlock(
  stream: SSEStreamingApi,
  startIndex: number,
): Promise<number> {
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index: startIndex,
      content_block: { type: "thinking", thinking: "" },
    }),
  })
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index: startIndex,
      delta: { type: "thinking_delta", thinking: "" },
    }),
  })
  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index: startIndex }),
  })
  return 1
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
  thinkingEnabled: boolean = false,
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

  // 1b. Emit a synthetic thinking block when the original request had
  // thinking enabled.  This lets Claude Code's UI show its progress indicators.
  const indexOffset =
    thinkingEnabled ? await emitSyntheticThinkingBlock(stream, 0) : 0

  // 2. Emit each content block as start + delta + stop
  for (let i = 0; i < anthropicResponse.content.length; i++) {
    const block = anthropicResponse.content[i]
    const blockIndex = i + indexOffset

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
