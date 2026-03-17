import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { isWebSearchEnabled, state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
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

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

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
    const copilotResponse = await fetchCopilotResponse(anthropicPayload)
    clearInterval(pingTimer)
    pingTimer = undefined

    if (isNonStreaming(copilotResponse)) {
      // Shouldn't happen for a streaming payload, but handle gracefully.
      consola.debug(
        "Non-streaming response from Copilot:",
        JSON.stringify(copilotResponse).slice(-400),
      )
      const anthropicResponse = translateToAnthropic(copilotResponse)
      await stream.writeSSE({
        event: "message_start",
        data: JSON.stringify(anthropicResponse),
      })
      return
    }

    await pipeStreamToClient(stream, copilotResponse)
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
  return createChatCompletions(openAIPayload)
}

async function pipeStreamToClient(
  stream: SSEStreamingApi,
  response: AsyncGenerator<ServerSentEventMessage, void, unknown>,
): Promise<void> {
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
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
