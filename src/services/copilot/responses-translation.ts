/**
 * Translation helpers between OpenAI Chat Completions format and Responses API format.
 *
 * Some models (e.g. gpt-5.4) only support the /responses endpoint.
 * These functions allow the proxy to transparently route those models while
 * returning a standard Chat Completions response to callers.
 */

import type { SSEMessage } from "hono/streaming"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ToolCall,
} from "./create-chat-completions"
import type { Model } from "./get-models"

// ─── Routing helper ──────────────────────────────────────────────────────────

/** Returns true if the model's only supported endpoint is /responses. */
export function requiresResponsesApi(model: Model): boolean {
  return (
    Array.isArray(model.supported_endpoints)
    && model.supported_endpoints.length === 1
    && model.supported_endpoints[0] === "/responses"
  )
}

// ─── Responses API payload types ─────────────────────────────────────────────

// Tool format for the Responses API — name/description/parameters are top-level,
// unlike Chat Completions where they are nested inside a `function` object.
export interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

export interface ResponsesPayload {
  model: string
  input: Array<{ role: string; content: unknown }>
  instructions?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean | null
  tools?: Array<ResponsesTool>
  tool_choice?: ChatCompletionsPayload["tool_choice"]
  text?: { format: { type: string } }
}

// ─── Responses API response types ────────────────────────────────────────────

interface ResponsesOutputMessage {
  type: "message"
  role: "assistant"
  content: Array<{ type: string; text?: string }>
}

interface ResponsesFunctionCall {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

type ResponsesOutputItem = ResponsesOutputMessage | ResponsesFunctionCall

interface ResponsesResponse {
  id: string
  model: string
  output: Array<ResponsesOutputItem>
  usage: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
}

// ─── Payload translation: Chat Completions → Responses API ───────────────────

export function translateToResponsesPayload(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  // Separate system message from the rest
  const systemMsg = payload.messages.find((m) => m.role === "system")
  const otherMessages = payload.messages.filter((m) => m.role !== "system")

  return {
    model: payload.model,
    input: otherMessages.map((m) => ({ role: m.role, content: m.content })),
    ...buildSystemInstruction(systemMsg),
    ...buildOptionalScalars(payload),
    ...buildTextFormat(payload.response_format),
  }
}

function buildSystemInstruction(
  systemMsg: ChatCompletionsPayload["messages"][number] | undefined,
): Pick<ResponsesPayload, "instructions"> | Record<string, never> {
  if (
    systemMsg?.content !== null
    && systemMsg?.content !== undefined
    && typeof systemMsg.content === "string"
  ) {
    return { instructions: systemMsg.content }
  }
  return {}
}

function buildOptionalScalars(
  payload: ChatCompletionsPayload,
): Partial<ResponsesPayload> {
  const out: Partial<ResponsesPayload> = {}
  if (payload.max_tokens !== null && payload.max_tokens !== undefined)
    out.max_output_tokens = payload.max_tokens
  if (payload.temperature !== null && payload.temperature !== undefined)
    out.temperature = payload.temperature
  if (payload.top_p !== null && payload.top_p !== undefined)
    out.top_p = payload.top_p
  if (payload.stream !== null && payload.stream !== undefined)
    out.stream = payload.stream
  if (payload.tools !== null && payload.tools !== undefined)
    out.tools = payload.tools.map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      ...(tool.function.description !== undefined && {
        description: tool.function.description,
      }),
      parameters: tool.function.parameters,
      ...(tool.function.strict !== undefined && {
        strict: tool.function.strict,
      }),
    }))
  if (payload.tool_choice !== null && payload.tool_choice !== undefined)
    out.tool_choice = payload.tool_choice
  return out
}

function buildTextFormat(
  responseFormat: ChatCompletionsPayload["response_format"],
): Pick<ResponsesPayload, "text"> | Record<string, never> {
  if (responseFormat !== null && responseFormat !== undefined) {
    return { text: { format: { type: responseFormat.type } } }
  }
  return {}
}

// ─── Response translation: Responses API → Chat Completions ──────────────────

export function translateFromResponsesResponse(
  resp: ResponsesResponse,
): ChatCompletionResponse {
  let textContent: string | null = null
  const toolCalls: Array<ToolCall> = []

  for (const item of resp.output) {
    if (item.type === "message") {
      const texts = item.content
        .filter(
          (c) =>
            c.type === "output_text" && c.text !== undefined && c.text !== "",
        )
        .map((c) => c.text as string)
      if (texts.length > 0) {
        textContent = texts.join("\n\n")
      }
    } else {
      // function_call — the union guarantees this branch
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      })
    }
  }

  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop"

  return {
    id: resp.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.total_tokens,
    },
  }
}

// ─── Stream translation: Responses API SSE event → Chat Completion SSE chunk ─

/**
 * Translates a single Responses API SSE event into a Chat Completion SSE message.
 * Returns null for event types that have no Chat Completions equivalent.
 */
/**
 * Mutable state shared across a single streaming response so that
 * `response.output_item.added` can hand off the tool-call identity
 * (call_id + name) to the subsequent `function_call_arguments.delta` chunks.
 */
export interface ResponsesStreamState {
  /** Pending tool-call identities keyed by Responses-API item id. */
  pendingToolCalls: Record<
    string,
    { call_id: string; name: string; sent: boolean }
  >
}

export function createResponsesStreamState(): ResponsesStreamState {
  return { pendingToolCalls: {} }
}

export interface TranslateStreamOptions {
  responseId: string
  model: string
  streamState: ResponsesStreamState
}

export function translateFromResponsesStream(
  event: Record<string, unknown>,
  options: TranslateStreamOptions,
): SSEMessage | null {
  const { responseId, model, streamState } = options
  const type = event.type as string

  if (type === "response.output_text.delta") {
    return makeTextDeltaChunk(responseId, model, event.delta as string)
  }

  if (type === "response.output_text.done") {
    return makeFinishChunk(responseId, model, "stop")
  }

  if (type === "response.output_item.added") {
    return handleOutputItemAdded(event, streamState)
  }

  if (type === "response.function_call_arguments.delta") {
    return handleFnCallArgsDelta(event, { responseId, model, streamState })
  }

  if (type === "response.function_call_arguments.done") {
    return makeFinishChunk(responseId, model, "tool_calls")
  }

  if (type === "response.completed") {
    return { data: "[DONE]" }
  }

  return null
}

/** Stash tool-call identity so argument deltas can reference it later. */
function handleOutputItemAdded(
  event: Record<string, unknown>,
  streamState: ResponsesStreamState,
): null {
  const item = event.item as Record<string, unknown> | undefined
  if (item?.type === "function_call" && item.call_id && item.name) {
    const itemId = item.id as string
    streamState.pendingToolCalls[itemId] = {
      call_id: item.call_id as string,
      name: item.name as string,
      sent: false,
    }
  }
  return null
}

/** Translate a function_call_arguments.delta event into a Chat Completion chunk. */
function handleFnCallArgsDelta(
  event: Record<string, unknown>,
  options: Pick<TranslateStreamOptions, "responseId" | "model" | "streamState">,
): SSEMessage {
  const { responseId, model, streamState } = options
  const itemId = event.item_id as string | undefined
  const pending =
    itemId !== undefined ? streamState.pendingToolCalls[itemId] : undefined

  // First delta for this tool call → attach id + name so the Anthropic
  // translator can open a content_block_start for the tool_use block.
  if (pending && !pending.sent) {
    pending.sent = true
    return makeToolCallChunk(responseId, model, {
      args: event.delta as string,
      identity: {
        id: pending.call_id,
        type: "function",
        name: pending.name,
      },
    })
  }

  return makeToolCallChunk(responseId, model, {
    args: event.delta as string,
  })
}

function makeTextDeltaChunk(
  id: string,
  model: string,
  content: string,
): SSEMessage {
  return makeChunk(id, model, {
    choices: [
      { index: 0, delta: { content }, finish_reason: null, logprobs: null },
    ],
  })
}

function makeFinishChunk(
  id: string,
  model: string,
  finishReason: string,
): SSEMessage {
  return makeChunk(id, model, {
    choices: [
      { index: 0, delta: {}, finish_reason: finishReason, logprobs: null },
    ],
  })
}

function makeToolCallChunk(
  id: string,
  model: string,
  toolCallData: {
    args: string
    identity?: { id: string; type: string; name: string }
  },
): SSEMessage {
  const { args, identity } = toolCallData
  const toolCall: Record<string, unknown> = {
    index: 0,
    ...(identity && { id: identity.id, type: identity.type }),
    function: {
      ...(identity && { name: identity.name }),
      arguments: args,
    },
  }
  return makeChunk(id, model, {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [toolCall] },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })
}

function makeChunk(
  id: string,
  model: string,
  extra: Record<string, unknown>,
): SSEMessage {
  return {
    data: JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      ...extra,
    }),
  }
}
