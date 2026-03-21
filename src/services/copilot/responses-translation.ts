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
  input: Array<ResponsesInputItem>
  instructions?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean | null
  tools?: Array<ResponsesTool>
  tool_choice?: ChatCompletionsPayload["tool_choice"]
  text?: { format: { type: string } }
}

// Responses API accepts three kinds of input items:
// 1. A message (user/assistant/developer with content)
// 2. A function_call (assistant deciding to call a tool)
// 3. A function_call_output (tool result)
type ResponsesInputItem =
  | { role: string; content: unknown }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }

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
    input: translateMessagesToResponsesInput(otherMessages),
    ...buildSystemInstruction(systemMsg),
    ...buildOptionalScalars(payload),
    ...buildTextFormat(payload.response_format),
  }
}

/**
 * Translates OpenAI Chat Completions messages into the Responses API input format.
 *
 * Key differences:
 * - Assistant messages with tool_calls → one or more `function_call` items
 * - Tool result messages (role: "tool") → `function_call_output` items
 * - Null content on assistant messages → empty string (Responses API rejects null)
 */
function translateMessagesToResponsesInput(
  messages: Array<import("./create-chat-completions").Message>,
): Array<ResponsesInputItem> {
  const items: Array<ResponsesInputItem> = []

  for (const msg of messages) {
    // Tool result messages → function_call_output
    if (msg.role === "tool" && msg.tool_call_id) {
      let output: string
      if (typeof msg.content === "string") {
        output = msg.content
      } else if (msg.content !== null) {
        output = JSON.stringify(msg.content)
      } else {
        output = ""
      }
      items.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output,
      })
      continue
    }

    // Assistant messages with tool_calls → emit function_call items
    // (plus a text message if the assistant also produced content)
    if (
      msg.role === "assistant"
      && msg.tool_calls
      && msg.tool_calls.length > 0
    ) {
      // If the assistant also has text content, emit it as a message first
      if (msg.content !== null && msg.content !== "") {
        items.push({
          role: msg.role,
          content:
            typeof msg.content === "string" ?
              msg.content
            : JSON.stringify(msg.content),
        })
      }

      // Emit each tool call as a function_call input item
      for (const tc of msg.tool_calls) {
        items.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })
      }
      continue
    }

    // Regular messages — ensure content is never null
    items.push({
      role: msg.role,
      content: msg.content ?? "",
    })
  }

  return items
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
 *
 * IDs from the Copilot API may be encrypted/opaque, so `item.id` from
 * `output_item.added` will NOT match `item_id` from the delta events.
 * We therefore use a FIFO queue: the Responses API always sends
 * `output_item.added` before its corresponding `function_call_arguments.delta`
 * events, so we push identity info onto the queue and shift it off when the
 * first delta for a new tool call arrives.
 */
export interface ResponsesStreamState {
  /** FIFO queue of tool-call identities waiting to be attached to deltas. */
  pendingToolCalls: Array<{ call_id: string; name: string }>
  /** Whether the current tool call's first delta has already been sent. */
  currentToolCallSent: boolean
  /** Whether any tool calls were seen during this response (for finish_reason). */
  hasToolCalls: boolean
  /** Whether any text content was seen during this response. */
  hasTextContent: boolean
}

export function createResponsesStreamState(): ResponsesStreamState {
  return {
    pendingToolCalls: [],
    currentToolCallSent: false,
    hasToolCalls: false,
    hasTextContent: false,
  }
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
    streamState.hasTextContent = true
    return makeTextDeltaChunk(responseId, model, event.delta as string)
  }

  if (type === "response.output_text.done") {
    // Don't emit a finish chunk here — the response may contain more output
    // items (e.g. tool calls after text). The finish chunk is emitted once
    // on `response.completed` when the entire response is done.
    return null
  }

  if (type === "response.output_item.added") {
    return handleOutputItemAdded(event, streamState)
  }

  if (type === "response.function_call_arguments.delta") {
    return handleFnCallArgsDelta(event, { responseId, model, streamState })
  }

  if (type === "response.function_call_arguments.done") {
    // Reset so the next tool call can pick up its identity from the queue.
    // Don't emit a finish chunk here — the response may contain more tool
    // calls. The finish chunk is emitted once on `response.completed`.
    streamState.currentToolCallSent = false
    return null
  }

  if (type === "response.completed") {
    // Emit the final finish chunk with the appropriate finish_reason,
    // then signal end-of-stream. This is the ONLY place we emit
    // finish_reason, ensuring the Anthropic message_delta + message_stop
    // sequence is sent exactly once per response.
    return makeFinishChunk(
      responseId,
      model,
      streamState.hasToolCalls ? "tool_calls" : "stop",
    )
  }

  return null
}

/** Stash tool-call identity so argument deltas can reference it later. */
function handleOutputItemAdded(
  event: Record<string, unknown>,
  streamState: ResponsesStreamState,
): null {
  const item = event.item as Record<string, unknown> | undefined
  // The Copilot API may encrypt/obfuscate field values, but `call_id` is
  // consistently readable. Accept the item if it has a `call_id` — the `type`
  // field may not always be present or may be obfuscated.
  if (item && item.call_id) {
    streamState.pendingToolCalls.push({
      call_id: item.call_id as string,
      name: typeof item.name === "string" ? item.name : "function",
    })
    streamState.hasToolCalls = true
  }
  return null
}

/** Translate a function_call_arguments.delta event into a Chat Completion chunk. */
function handleFnCallArgsDelta(
  event: Record<string, unknown>,
  options: Pick<TranslateStreamOptions, "responseId" | "model" | "streamState">,
): SSEMessage {
  const { responseId, model, streamState } = options

  // If there's a pending tool call identity and we haven't attached it yet,
  // this is the first delta for a new tool call → attach id + name.
  if (
    streamState.pendingToolCalls.length > 0
    && !streamState.currentToolCallSent
  ) {
    // Safe to shift — length check above guarantees at least one element.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const pending = streamState.pendingToolCalls.shift()!
    streamState.currentToolCallSent = true
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
