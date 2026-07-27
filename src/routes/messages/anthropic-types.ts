import type { ToolNameMap } from "./tool-name-mapping"

// Anthropic API Types

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens: number
  system?: string | Array<AnthropicSystemBlock>
  metadata?: {
    user_id?: string
  }
  stop_sequences?: Array<string>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none"
    name?: string
    disable_parallel_tool_use?: boolean // parsed but not forwarded — no OpenAI equivalent
  }
  thinking?: {
    /**
     * `enabled` is the classic explicit opt-in.  `adaptive` is what Claude Code
     * and Claude Desktop send for Claude 4.6 and later — and, per the gateway
     * protocol reference, for any model name they don't recognize (including
     * gateway aliases), so it arrives on most requests.  `disabled` turns
     * reasoning off.
     *
     * @see https://code.claude.com/docs/en/llm-gateway-protocol
     */
    type: "enabled" | "adaptive" | "disabled"
    budget_tokens?: number
  }
  service_tier?: "auto" | "standard_only"
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max"
    format?: { type: "json_schema"; schema: Record<string, unknown> }
  }
  speed?: "standard" | "fast"
  cache_control?: { type: "ephemeral"; ttl?: number }
  container?: Record<string, unknown>
  mcp_servers?: Array<Record<string, unknown>>
  context_management?: Record<string, unknown>
  inference_geo?: string
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: { type: "ephemeral"; ttl?: number }
  citations?: Array<unknown> // pass-through, not interpreted by proxy
}

/**
 * Catch-all for system-level blocks with unknown `type` values (e.g.
 * cache_control-only blocks, future block types). Allows `system` arrays
 * to contain non-text entries without losing type safety on known blocks.
 */
export interface AnthropicGenericSystemBlock {
  type: string
  [key: string]: unknown
}

export type AnthropicSystemBlock =
  | AnthropicTextBlock
  | AnthropicGenericSystemBlock

export interface AnthropicImageBlock {
  type: "image"
  source:
    | {
        type: "base64"
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        data: string
      }
    | { type: "url"; url: string }
}

// New: document block (PDFs sent via Read tool)
// source union covers all Anthropic-documented source types; handler emits a
// placeholder string regardless, so media_type is intentionally wide.
export interface AnthropicDocumentBlock {
  type: "document"
  title?: string
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string }
    | { type: "text"; data: string }
  cache_control?: { type: "ephemeral"; ttl?: number }
}

/**
 * Client-side ToolSearch result used by Claude Code 2.1.210+.
 * It is nested inside a normal `tool_result.content` array and replayed in
 * subsequent Messages requests.
 */
export interface AnthropicToolReferenceBlock {
  type: "tool_reference"
  tool_name: string
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content:
    | string
    | Array<
        | AnthropicTextBlock
        | AnthropicImageBlock
        | AnthropicDocumentBlock
        | AnthropicToolReferenceBlock
      >
  is_error?: boolean
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: { type: "ephemeral"; ttl?: number }
  caller?: Record<string, unknown>
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string // Used by Claude Code extended thinking
}

// New: redacted thinking (redact-thinking-2026-02-12 beta)
export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}

// New: server-side tool use block in assistant messages
// Appears in multi-turn histories from real Anthropic API with web_search server tool
export interface AnthropicServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

// New: web search tool result block in user messages
// Appears in multi-turn histories from real Anthropic API with web_search server tool
export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content: unknown
}

export interface AnthropicSearchResultBlock {
  type: "search_result"
  source: string
  title: string
  content: string
  cache_control?: { type: "ephemeral"; ttl?: number }
  citations?: Array<unknown>
  search_result_index?: number
  start_block_index?: number
  end_block_index?: number
}

export interface AnthropicContainerUploadBlock {
  type: "container_upload"
  file_id: string
  cache_control?: { type: "ephemeral"; ttl?: number }
}

/**
 * Mid-conversation system instructions embedded inside a user message.
 * Introduced in the 2025 Messages API: the Claude app / Claude Code
 * (v1.24012.92+) delivers updated system guidance mid-conversation either as a
 * `role: "system"` message (see {@link AnthropicSystemMessage}) or as this
 * block inside a user message.
 *
 * @see https://platform.claude.com/docs/en/api/messages (ContentBlockParam)
 */
export interface AnthropicMidConversationSystemBlock {
  type: "mid_conv_system"
  content: string | Array<AnthropicTextBlock>
  cache_control?: { type: "ephemeral"; ttl?: number }
}

interface ServerToolResultBase {
  tool_use_id: string
  content: unknown
  cache_control?: { type: "ephemeral"; ttl?: number }
}

interface AnthropicWebFetchToolResultBlock extends ServerToolResultBase {
  type: "web_fetch_tool_result"
}

interface AnthropicCodeExecutionToolResultBlock extends ServerToolResultBase {
  type: "code_execution_tool_result"
}

interface AnthropicBashCodeExecutionToolResultBlock
  extends ServerToolResultBase {
  type: "bash_code_execution_tool_result"
}

interface AnthropicTextEditorCodeExecutionToolResultBlock
  extends ServerToolResultBase {
  type: "text_editor_code_execution_tool_result"
}

interface AnthropicToolSearchToolResultBlock extends ServerToolResultBase {
  type: "tool_search_tool_result"
}

export type AnthropicServerToolResultBlock =
  | AnthropicWebSearchToolResultBlock
  | AnthropicWebFetchToolResultBlock
  | AnthropicCodeExecutionToolResultBlock
  | AnthropicBashCodeExecutionToolResultBlock
  | AnthropicTextEditorCodeExecutionToolResultBlock
  | AnthropicToolSearchToolResultBlock

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolReferenceBlock
  | AnthropicToolResultBlock
  | AnthropicSearchResultBlock
  | AnthropicContainerUploadBlock
  | AnthropicMidConversationSystemBlock
  | AnthropicServerToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicServerToolUseBlock
  | AnthropicServerToolResultBlock

export interface AnthropicUserMessage {
  role: "user"
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: "assistant"
  content: string | Array<AnthropicAssistantContentBlock>
}

/**
 * A `role: "system"` message inside the `messages[]` array. The Anthropic
 * Messages API now recognizes `"system"` as a third role (alongside `"user"`
 * and `"assistant"`) for mid-conversation system instructions, and the Claude
 * app / Claude Code (v1.24012.92+) actively sends them. The LLM gateway
 * protocol is explicit that rejecting these makes the client silently retry
 * with the feature disabled for the rest of the conversation.
 *
 * @see https://code.claude.com/docs/en/llm-gateway-protocol
 * @see https://platform.claude.com/docs/en/api/messages (MessageParam.role)
 */
export interface AnthropicSystemMessage {
  role: "system"
  content: string | Array<AnthropicUserContentBlock>
}

export type AnthropicMessage =
  | AnthropicUserMessage
  | AnthropicAssistantMessage
  | AnthropicSystemMessage

// Custom tool (has input_schema) — what Claude Code and standard clients send
export interface AnthropicCustomTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  strict?: boolean
  cache_control?: { type: "ephemeral"; ttl?: number }
  defer_loading?: boolean
  input_examples?: Array<unknown>
  eager_input_streaming?: boolean
  allowed_callers?: Array<string>
}

// Anthropic-typed tool (versioned type string, no input_schema)
// Examples: bash_20250124, text_editor_20250728, computer_20251124, web_search_20250305
interface AnthropicTypedTool {
  type: string
  name: string
  [key: string]: unknown
}

export type AnthropicTool = AnthropicCustomTool | AnthropicTypedTool

// Discriminant: typed tools never have input_schema; custom tools always do.
// Using presence of input_schema is more robust than checking for type,
// since a future custom tool definition could include a type field.
export function isTypedTool(tool: AnthropicTool): tool is AnthropicTypedTool {
  return !("input_schema" in tool)
}

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: "standard" | "priority" | "batch"
  }
}

export type AnthropicResponseContentBlock = AnthropicAssistantContentBlock

// Anthropic Stream Event Types
export interface AnthropicMessageStartEvent {
  type: "message_start"
  message: Omit<
    AnthropicResponse,
    "content" | "stop_reason" | "stop_sequence"
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string }
    | {
        type: "server_tool_use"
        id: string
        name: string
        input: Record<string, unknown>
      }
    | AnthropicServerToolResultBlock
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
    | { type: "citations_delta"; citation: unknown }
    | { type: "compaction_delta"; content: unknown }
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta"
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"]
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface AnthropicMessageStopEvent {
  type: "message_stop"
}

export interface AnthropicPingEvent {
  type: "ping"
}

export interface AnthropicErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// State for streaming translation
export interface AnthropicStreamState {
  messageStartSent: boolean
  /** Whether the terminal message_stop event has been emitted. */
  messageStopSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  /** Whether the currently open content block is a thinking block. */
  thinkingBlockOpen: boolean
  /** Whether any visible text content has been emitted in this response. */
  hasEmittedText: boolean
  /** Whether any thinking (reasoning) content has been emitted in this response. */
  hasEmittedThinking: boolean
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
      /** Accumulated JSON argument fragments for truncation detection. */
      accumulatedArgs: string
    }
  }
  /** Maps OpenAI-safe function names back to the original Anthropic tool names. */
  toolNameMap?: ToolNameMap
  /** Whether the original request included thinking: { type: "enabled" }. */
  thinkingEnabled: boolean
  /**
   * Last usage data seen from any upstream chunk.  With `stream_options:
   * { include_usage: true }`, the OpenAI API sends usage in the final chunk
   * (often after the finish_reason chunk).  We accumulate it here so the
   * `message_delta` event can include accurate `input_tokens`.
   */
  lastSeenUsage?: {
    prompt_tokens: number
    completion_tokens: number
    prompt_tokens_details?: { cached_tokens: number }
  }
  /**
   * Deferred finish_reason — set when we see `finish_reason` but want to
   * delay emitting `message_delta` + `message_stop` until after the usage
   * chunk arrives (or the stream ends).
   */
  deferredFinishReason?:
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter"
    | null
}

/**
 * Whether a request's `thinking` field asks for reasoning.
 *
 * Claude Code and Claude Desktop send `{"type": "adaptive"}` for Claude 4.6 and
 * later, and — per the gateway protocol reference — treat model names they
 * don't recognize (such as gateway aliases) as current models that receive the
 * field.  Behind this proxy every Claude model is effectively an alias, so
 * `adaptive` arrives on the majority of desktop requests.
 *
 * Matching only `"enabled"` therefore read as "thinking off" for real traffic:
 * upstream reasoning was never requested, and any reasoning the model produced
 * anyway was rendered as ordinary assistant text — the model's private
 * chain-of-thought shown to the user as its answer.
 *
 * @see https://code.claude.com/docs/en/llm-gateway-protocol
 */
export function isThinkingRequested(
  thinking: AnthropicMessagesPayload["thinking"],
): thinking is NonNullable<AnthropicMessagesPayload["thinking"]> {
  return thinking?.type === "enabled" || thinking?.type === "adaptive"
}
