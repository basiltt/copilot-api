/* eslint-disable max-lines */
/**
 * Translation helpers between OpenAI Chat Completions format and Responses API format.
 */

import type { SSEMessage } from "hono/streaming"

import type {
  ContentPart,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Tool,
  ToolCall,
} from "./create-chat-completions"
import type { Model } from "./get-models"

// ─── Routing helper ──────────────────────────────────────────────────────────

/**
 * Returns true if the model does not support /chat/completions and should
 * be routed through the /responses endpoint instead.
 *
 * This handles models like gpt-5.4-mini that appear in the model list but
 * whose `supported_endpoints` either explicitly excludes /chat/completions
 * or only lists /responses.
 */
export function requiresResponsesApi(model: Model): boolean {
  if (!Array.isArray(model.supported_endpoints)) return false
  return !model.supported_endpoints.includes("/chat/completions")
}

// ─── Responses API payload types ─────────────────────────────────────────────

// Tool format for the Responses API — Codex sends various tool types:
// function, local_shell, custom, web_search, image_generation, namespace, tool_search
export interface ResponsesTool {
  type: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
  [key: string]: unknown
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
  parallel_tool_calls?: boolean
  reasoning?: { effort?: string; summary?: string }
  text?: {
    format: {
      type: string
      name?: string
      schema?: Record<string, unknown>
      strict?: boolean
    }
  }
}

// Responses API accepts three kinds of input items:
// 1. A message (user/assistant/developer with content)
// 2. A function_call (assistant deciding to call a tool)
// 3. A function_call_output (tool result)
type ResponsesInputItem =
  | { role: string; content: string | Array<ResponsesContentPart> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }

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
      content: translateMessageContentToResponses(msg.content),
    })
  }

  return items
}

function translateMessageContentToResponses(
  content: import("./create-chat-completions").Message["content"],
): string | Array<ResponsesContentPart> {
  if (content === null) return ""
  if (typeof content === "string") return content
  return content.map((part) => translateContentPartToResponses(part))
}

function translateContentPartToResponses(
  part: ContentPart,
): ResponsesContentPart {
  if (part.type === "text") {
    return {
      type: "input_text",
      text: part.text,
    }
  }

  return {
    type: "input_image",
    image_url: part.image_url.url,
    ...(part.image_url.detail !== undefined && {
      detail: part.image_url.detail,
    }),
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
    if (responseFormat.type === "json_schema") {
      return {
        text: {
          format: {
            type: "json_schema",
            name: responseFormat.json_schema.name,
            schema: responseFormat.json_schema.schema,
            strict: responseFormat.json_schema.strict,
          },
        },
      }
    }
    return { text: { format: { type: responseFormat.type } } }
  }
  return {}
}

// ─── Routing helper: Claude models need Chat Completions ────────────────────
export function requiresChatCompletionsApi(model: string): boolean {
  return model.startsWith("claude-")
}

// ─── Payload translation: Responses API → Chat Completions ──────────────────
export function translateFromResponsesPayloadToCC(
  payload: ResponsesPayload,
): ChatCompletionsPayload {
  const messages: Array<import("./create-chat-completions").Message> = []

  if (payload.instructions) {
    messages.push({ role: "system", content: payload.instructions })
  }

  for (const item of payload.input) {
    const msg = translateInputItemToMessage(item)
    if (msg) messages.push(msg)
  }

  const result: ChatCompletionsPayload = {
    model: payload.model,
    messages,
  }

  applyOptionalPayloadFields(payload, result)

  return result
}

function translateInputItemToMessage(
  item: ResponsesInputItem,
): import("./create-chat-completions").Message | null {
  const rawItem = item as Record<string, unknown>
  const type = rawItem.type as string | undefined

  if (type === "function_call") {
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: rawItem.call_id as string,
          type: "function",
          function: {
            name: rawItem.name as string,
            arguments: rawItem.arguments as string,
          },
        },
      ],
    }
  }
  if (type === "function_call_output") {
    return {
      role: "tool",
      content: rawItem.output as string,
      tool_call_id: rawItem.call_id as string,
    }
  }

  const content = translateResponsesContentToCC(
    rawItem.content as string | Array<ResponsesContentPart>,
  )
  if (content === null) return null

  return {
    role: rawItem.role as string as
      | "user"
      | "assistant"
      | "system"
      | "developer",
    content,
  }
}

function applyOptionalPayloadFields(
  payload: ResponsesPayload,
  result: ChatCompletionsPayload,
): void {
  if (payload.max_output_tokens !== undefined)
    result.max_tokens = payload.max_output_tokens
  if (payload.temperature !== undefined)
    result.temperature = payload.temperature
  if (payload.top_p !== undefined) result.top_p = payload.top_p
  if (payload.stream !== undefined) result.stream = payload.stream
  if (payload.stream) {
    result.stream_options = { include_usage: true }
  }
  if (payload.tool_choice !== undefined)
    result.tool_choice = payload.tool_choice

  applyToolsAndFormat(payload, result)
}

function applyToolsAndFormat(
  payload: ResponsesPayload,
  result: ChatCompletionsPayload,
): void {
  if (payload.tools && payload.tools.length > 0) {
    const ccTools = payload.tools
      .map((t) => responsesToolToCC(t))
      .filter((t): t is NonNullable<typeof t> => t !== null)
    if (ccTools.length > 0) {
      result.tools = ccTools
    }
  }

  if (payload.text?.format) {
    const fmt = payload.text.format
    if (fmt.type === "json_schema" && fmt.name && fmt.schema) {
      result.response_format = {
        type: "json_schema",
        json_schema: {
          name: fmt.name,
          schema: fmt.schema,
          strict: fmt.strict,
        },
      }
    } else if (fmt.type === "json_object") {
      result.response_format = { type: "json_object" }
    }
  }
}

function responsesToolToCC(t: ResponsesTool): Tool | null {
  if (t.type === "function" && t.name) {
    return {
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? {},
        ...(t.strict !== undefined && { strict: t.strict }),
      },
    }
  }
  if (t.type === "local_shell") {
    return {
      type: "function" as const,
      function: {
        name: "shell",
        description: "Execute a shell command",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "array",
              items: { type: "string" },
              description: "Command and arguments to execute",
            },
          },
          required: ["command"],
        },
      },
    }
  }
  if (t.type === "custom" && t.name) {
    return {
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? {},
      },
    }
  }
  return null
}

function translateResponsesContentToCC(
  content: string | Array<ResponsesContentPart>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") return content

  const parts: Array<ContentPart> = []
  for (const part of content) {
    if (part.type === "input_text") {
      parts.push({ type: "text" as const, text: part.text })
    } else if ("image_url" in part && part.image_url) {
      parts.push({
        type: "image_url" as const,
        image_url: {
          url: part.image_url,
          ...(part.detail && { detail: part.detail }),
        },
      })
    }
  }

  if (parts.length === 0) return null
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text
  return parts
}

// ─── Response translation: Chat Completions → Responses API ─────────────────
export function translateFromCCToResponsesResponse(
  resp: ChatCompletionResponse,
  responsesId?: string,
): Record<string, unknown> {
  const id = responsesId ?? `resp_${Date.now()}`
  const choice = resp.choices.at(0)
  if (!choice) {
    return { id, object: "response", model: resp.model, output: [], usage: {} }
  }

  const output: Array<Record<string, unknown>> = []

  if (choice.message.content) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: choice.message.content }],
    })
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })
    }
  }

  return {
    id,
    object: "response",
    model: resp.model,
    output,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      total_tokens: resp.usage?.total_tokens ?? 0,
    },
  }
}

// ─── Stream translation: CC SSE chunk → Responses API SSE events ────────────
export interface CCToResponsesStreamState {
  outputIndex: number
  textItemAdded: boolean
  reasoningSummaryAdded: boolean
  pendingToolCalls: Map<number, { id: string; name: string }>
  toolItemsAdded: Set<number>
  usage: { input_tokens: number; output_tokens: number; total_tokens: number }
  accumulatedText: string
  accumulatedReasoningText: string
  accumulatedToolArgs: Map<number, string>
}

export function createCCToResponsesStreamState(): CCToResponsesStreamState {
  return {
    outputIndex: 0,
    textItemAdded: false,
    reasoningSummaryAdded: false,
    pendingToolCalls: new Map(),
    toolItemsAdded: new Set(),
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    accumulatedText: "",
    accumulatedReasoningText: "",
    accumulatedToolArgs: new Map(),
  }
}

interface ResponsesSSEEvent {
  event: string
  data: string
}

export function translateFromCCStreamToResponsesEvents(
  chunk: Record<string, unknown>,
  streamState: CCToResponsesStreamState,
): Array<ResponsesSSEEvent> {
  // Capture usage from the final chunk (sent when stream_options.include_usage is set)
  const usage = chunk.usage as Record<string, number> | undefined
  if (usage) {
    streamState.usage = {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    }
  }

  const choices = chunk.choices as Array<Record<string, unknown>> | undefined
  if (!choices || choices.length === 0) return []

  const choice = choices[0]
  const delta = choice.delta as Record<string, unknown> | undefined
  if (!delta) return []

  const result: Array<ResponsesSSEEvent> = []
  const responseId = chunk.id as string
  const model = chunk.model as string

  if (delta.content && typeof delta.content === "string") {
    handleCCTextDelta(delta.content, streamState, result)
  }

  const reasoning =
    (delta.reasoning_content as string | undefined)
    ?? (delta.reasoning_text as string | undefined)
  if (reasoning) {
    handleCCReasoningDelta(reasoning, streamState, result)
  }

  const toolCalls = delta.tool_calls as
    | Array<Record<string, unknown>>
    | undefined
  if (toolCalls) {
    handleCCToolCallDeltas(toolCalls, streamState, result)
  }

  const finishReason = choice.finish_reason as string | null
  if (finishReason) {
    handleCCFinishReason(finishReason, responseId, {
      model,
      out: result,
      streamState,
    })
  }

  return result
}

function handleCCTextDelta(
  content: string,
  streamState: CCToResponsesStreamState,
  out: Array<ResponsesSSEEvent>,
): void {
  streamState.accumulatedText += content
  if (!streamState.textItemAdded) {
    streamState.textItemAdded = true
    out.push(
      {
        event: "response.output_item.added",
        data: JSON.stringify({
          type: "response.output_item.added",
          output_index: streamState.outputIndex,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "" }],
          },
        }),
      },
      {
        event: "response.content_part.added",
        data: JSON.stringify({
          type: "response.content_part.added",
          output_index: streamState.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "" },
        }),
      },
    )
  }
  out.push({
    event: "response.output_text.delta",
    data: JSON.stringify({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: content,
    }),
  })
}

function handleCCReasoningDelta(
  content: string,
  streamState: CCToResponsesStreamState,
  out: Array<ResponsesSSEEvent>,
): void {
  streamState.accumulatedReasoningText += content
  if (!streamState.reasoningSummaryAdded) {
    streamState.reasoningSummaryAdded = true
    out.push({
      event: "response.reasoning_summary_part.added",
      data: JSON.stringify({
        type: "response.reasoning_summary_part.added",
        output_index: streamState.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    })
  }
  out.push({
    event: "response.reasoning_summary_text.delta",
    data: JSON.stringify({
      type: "response.reasoning_summary_text.delta",
      output_index: streamState.outputIndex,
      summary_index: 0,
      delta: content,
    }),
  })
}

function getToolOutputIndex(
  tcIndex: number,
  streamState: CCToResponsesStreamState,
): number {
  return streamState.textItemAdded ?
      streamState.outputIndex + 1 + tcIndex
    : streamState.outputIndex + tcIndex
}

function handleCCToolCallDeltas(
  toolCalls: Array<Record<string, unknown>>,
  streamState: CCToResponsesStreamState,
  out: Array<ResponsesSSEEvent>,
): void {
  for (const tc of toolCalls) {
    const index = (tc.index as number | undefined) ?? 0
    const fn = tc.function as Record<string, unknown> | undefined

    if (tc.id && fn?.name) {
      streamState.pendingToolCalls.set(index, {
        id: tc.id as string,
        name: fn.name as string,
      })
    }

    if (
      !streamState.toolItemsAdded.has(index)
      && streamState.pendingToolCalls.has(index)
    ) {
      streamState.toolItemsAdded.add(index)
      const info = streamState.pendingToolCalls.get(index)
      if (info) {
        out.push({
          event: "response.output_item.added",
          data: JSON.stringify({
            type: "response.output_item.added",
            output_index: getToolOutputIndex(index, streamState),
            item: {
              type: "function_call",
              call_id: info.id,
              name: info.name,
              arguments: "",
            },
          }),
        })
      }
    }

    if (fn?.arguments && typeof fn.arguments === "string") {
      const prev = streamState.accumulatedToolArgs.get(index) ?? ""
      streamState.accumulatedToolArgs.set(index, prev + fn.arguments)
      out.push({
        event: "response.function_call_arguments.delta",
        data: JSON.stringify({
          type: "response.function_call_arguments.delta",
          output_index: getToolOutputIndex(index, streamState),
          delta: fn.arguments,
        }),
      })
    }
  }
}

function handleCCFinishReason(
  finishReason: string,
  responseId: string,
  {
    model,
    out,
    streamState,
  }: {
    model: string
    out: Array<ResponsesSSEEvent>
    streamState: CCToResponsesStreamState
  },
): void {
  if (finishReason === "length" && streamState.pendingToolCalls.size > 0) {
    handleCCTextDelta(
      "\n\n[Tool call was truncated due to output token limit. Please retry with a higher max_output_tokens.]",
      streamState,
      out,
    )
  }

  emitDoneEvents(streamState, out)

  const status = finishReason === "length" ? "incomplete" : "completed"
  out.push({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        model,
        status,
        output: [],
        usage: streamState.usage,
      },
    }),
  })
}

function emitDoneEvents(
  streamState: CCToResponsesStreamState,
  out: Array<ResponsesSSEEvent>,
): void {
  if (streamState.reasoningSummaryAdded) {
    out.push(
      {
        event: "response.reasoning_summary_text.done",
        data: JSON.stringify({
          type: "response.reasoning_summary_text.done",
          output_index: streamState.outputIndex,
          summary_index: 0,
          text: streamState.accumulatedReasoningText,
        }),
      },
      {
        event: "response.reasoning_summary_part.done",
        data: JSON.stringify({
          type: "response.reasoning_summary_part.done",
          output_index: streamState.outputIndex,
          summary_index: 0,
          part: {
            type: "summary_text",
            text: streamState.accumulatedReasoningText,
          },
        }),
      },
    )
  }

  if (streamState.textItemAdded) {
    out.push(
      {
        event: "response.content_part.done",
        data: JSON.stringify({
          type: "response.content_part.done",
          output_index: streamState.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: streamState.accumulatedText },
        }),
      },
      {
        event: "response.output_item.done",
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: streamState.outputIndex,
          item: {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: streamState.accumulatedText },
            ],
          },
        }),
      },
    )
  }

  for (const index of streamState.toolItemsAdded) {
    const info = streamState.pendingToolCalls.get(index)
    if (!info) continue
    const args = streamState.accumulatedToolArgs.get(index) ?? ""
    out.push(
      {
        event: "response.function_call_arguments.done",
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          output_index: getToolOutputIndex(index, streamState),
          call_id: info.id,
          name: info.name,
          arguments: args,
        }),
      },
      {
        event: "response.output_item.done",
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: getToolOutputIndex(index, streamState),
          item: {
            type: "function_call",
            call_id: info.id,
            name: info.name,
            arguments: args,
          },
        }),
      },
    )
  }
}

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

  // Reasoning summary text deltas — GPT 5.4 and other reasoning models emit
  // these while "thinking". Translate them to reasoning_content so the
  // Anthropic stream translator can emit them as thinking blocks, giving the
  // user visible progress during the model's reasoning phase.
  if (type === "response.reasoning_summary_text.delta") {
    return makeReasoningDeltaChunk(responseId, model, event.delta as string)
  }

  // Lifecycle events for reasoning summary — no content to forward.
  if (
    type === "response.reasoning_summary_text.done"
    || type === "response.reasoning_summary_part.added"
    || type === "response.reasoning_summary_part.done"
  ) {
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

function makeReasoningDeltaChunk(
  id: string,
  model: string,
  reasoningContent: string,
): SSEMessage {
  return makeChunk(id, model, {
    choices: [
      {
        index: 0,
        delta: { reasoning_content: reasoningContent },
        finish_reason: null,
        logprobs: null,
      },
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
