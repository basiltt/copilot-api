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

export const createResponsesCompletion = async (
  payload: ChatCompletionsPayload,
): Promise<
  ChatCompletionResponse | AsyncIterable<import("hono/streaming").SSEMessage>
> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const responsesPayload = translateToResponsesPayload(payload)

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(responsesPayload),
    signal: AbortSignal.timeout(10 * 60 * 1000),
    // @ts-expect-error — Bun-specific option
    timeout: false,
  })

  if (!response.ok) {
    throw new HTTPError("Failed to create responses completion", response)
  }

  if (payload.stream) {
    const responseId = `resp_${Date.now()}`
    const model = payload.model
    const streamState = createResponsesStreamState()

    async function* streamChunks() {
      consola.debug("[responses-stream] Starting stream iteration")
      let eventCount = 0
      let yieldCount = 0
      for await (const event of events(response)) {
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
          consola.debug("[responses-stream] Failed to parse event data as JSON")
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
          yieldCount++
          consola.debug(
            `[responses-stream] Yielding chunk #${yieldCount}:`,
            JSON.stringify(chunk).slice(0, 200),
          )
          yield chunk
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
    }

    return streamChunks()
  }

  const data = await response.json()
  return translateFromResponsesResponse(
    data as Parameters<typeof translateFromResponsesResponse>[0],
  )
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60 * 1000),
    // Bun's internal fetch timer defaults to ~4 minutes and fires mid-stream
    // when Copilot pauses between chunks on large (6000+ line) file edits.
    // Setting timeout:false disables it; AbortSignal above is the safety net.
    // @ts-expect-error — Bun-specific option, not in the standard fetch types
    timeout: false,
  })

  if (!response.ok) {
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

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
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
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
