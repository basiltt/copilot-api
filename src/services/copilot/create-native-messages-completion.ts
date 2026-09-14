/* eslint-disable max-lines -- Native body mapping and SSE protocol validation share one transport boundary. */
import type { ServerSentEventMessage } from "fetch-event-stream"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type { ToolNameMap } from "~/routes/messages/tool-name-mapping"
import type {
  ChatCompletionResponse,
  FinalUpstreamRequestShape,
  NativeMessagesRejectionReason,
} from "~/services/copilot/create-chat-completions"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { requestSignal } from "~/lib/request-lifecycle"
import { state } from "~/lib/state"
import {
  createInactivityAbort,
  fetchWithInactivity,
  responseEvents,
} from "~/lib/upstream-lifecycle"
import {
  toAnthropicToolIdentity,
  toOpenAIToolName,
} from "~/routes/messages/tool-name-mapping"
import { attachFinalUpstreamRequestShape } from "~/services/copilot/create-chat-completions"

const nativeMessagesResponse = Symbol("nativeMessagesResponse")
const bufferedNativeResponse = Symbol("bufferedNativeResponse")
const NATIVE_USER_BLOCK_TYPES = new Set([
  "text",
  "image",
  "document",
  "tool_reference",
  "tool_result",
])
const NATIVE_ASSISTANT_BLOCK_TYPES = new Set([
  "text",
  "tool_use",
  "thinking",
  "redacted_thinking",
])
const NATIVE_TOOL_RESULT_BLOCK_TYPES = new Set([
  "text",
  "image",
  "document",
  "tool_reference",
])

export type NativeMessagesCompatibility =
  | "native_selected"
  | "native_disabled"
  | "model_not_advertised"
  | "request_unsupported"

export interface NativeMessagesCompatibilityResult {
  routing: NativeMessagesCompatibility
  rejectionReasons: Array<NativeMessagesRejectionReason>
}

type NativeStreamEvent = Record<string, unknown>

function invalidNativeResponse(message: string): never {
  throw new HTTPError(
    message,
    Response.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: "Native Messages upstream returned an invalid response.",
        },
      },
      { status: 502 },
    ),
  )
}

function invalidNativeRequest(message: string): never {
  throw new HTTPError(
    message,
    Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message },
      },
      { status: 400 },
    ),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasTypedTools(tools: Array<AnthropicTool> | undefined): boolean {
  return Boolean(tools?.some((tool) => !("input_schema" in tool)))
}

function nativeToolResultContentRejection(
  value: unknown,
): NativeMessagesRejectionReason | undefined {
  if (value === undefined || value === null)
    return "tool_result_content_missing"
  if (typeof value === "string") return undefined
  if (!Array.isArray(value)) return "tool_result_content_unsupported"
  return (
      value.every(
        (block) =>
          isRecord(block)
          && typeof block.type === "string"
          && NATIVE_TOOL_RESULT_BLOCK_TYPES.has(block.type),
      )
    ) ?
      undefined
    : "tool_result_content_unsupported"
}

function unsupportedBlockReason(
  role: "user" | "assistant",
): NativeMessagesRejectionReason {
  return role === "user" ?
      "user_block_unsupported"
    : "assistant_block_unsupported"
}

function unsupportedMessageRoleReason(
  candidate: Record<string, unknown>,
): NativeMessagesRejectionReason {
  if (!Object.hasOwn(candidate, "role") || candidate.role === undefined)
    return "message_role_absent"
  if (candidate.role === "system") return "message_role_system"
  if (candidate.role === "developer") return "message_role_developer"
  if (candidate.role === "tool") return "message_role_tool"
  return "message_role_other"
}

function addKnownNativeBlockRejections(
  candidate: Record<string, unknown>,
  reasons: Set<NativeMessagesRejectionReason>,
): void {
  const type = candidate.type
  if (type === "thinking") {
    if (typeof candidate.thinking !== "string") reasons.add("thinking_invalid")
    if (
      typeof candidate.signature !== "string"
      || candidate.signature.length === 0
    )
      reasons.add("thinking_signature_missing")
  }
  if (
    type === "redacted_thinking"
    && (typeof candidate.data !== "string" || candidate.data.length === 0)
  )
    reasons.add("redacted_thinking_invalid")
  if (
    type === "tool_use"
    && (typeof candidate.id !== "string"
      || typeof candidate.name !== "string"
      || !isRecord(candidate.input))
  )
    reasons.add("tool_use_invalid")
  if (type === "tool_result") {
    const rejection = nativeToolResultContentRejection(candidate.content)
    if (rejection) reasons.add(rejection)
  }
}

function addNativeBlockRejections(
  candidate: unknown,
  role: "user" | "assistant",
  reasons: Set<NativeMessagesRejectionReason>,
): void {
  if (!isRecord(candidate) || typeof candidate.type !== "string") {
    reasons.add(unsupportedBlockReason(role))
    return
  }
  const allowed =
    role === "user" ? NATIVE_USER_BLOCK_TYPES : NATIVE_ASSISTANT_BLOCK_TYPES
  const type = candidate.type
  if (!allowed.has(type)) {
    reasons.add(unsupportedBlockReason(role))
    return
  }
  addKnownNativeBlockRejections(candidate, reasons)
}

function nativeMessageContentRejections(
  payload: AnthropicMessagesPayload,
): Array<NativeMessagesRejectionReason> {
  const reasons = new Set<NativeMessagesRejectionReason>()
  if (
    Array.isArray(payload.system)
    && !payload.system.every(
      (block) =>
        isRecord(block)
        && typeof block.type === "string"
        && block.type === "text",
    )
  )
    reasons.add("system_block_unsupported")
  if (!Array.isArray(payload.messages)) {
    reasons.add("message_content_invalid")
    return [...reasons]
  }
  for (const candidateMessage of payload.messages as Array<unknown>) {
    if (!isRecord(candidateMessage)) {
      reasons.add("message_nonobject")
      continue
    }
    if (
      candidateMessage.role !== "user"
      && candidateMessage.role !== "assistant"
    ) {
      reasons.add(unsupportedMessageRoleReason(candidateMessage))
      continue
    }
    if (typeof candidateMessage.content === "string") continue
    if (!Array.isArray(candidateMessage.content)) {
      reasons.add("message_content_invalid")
      continue
    }
    for (const candidate of candidateMessage.content)
      addNativeBlockRejections(candidate, candidateMessage.role, reasons)
  }
  return [...reasons]
}

export function nativeMessagesCompatibility(
  payload: AnthropicMessagesPayload,
  supportedEndpoints: Array<string> | undefined,
): NativeMessagesCompatibility {
  return evaluateNativeMessagesCompatibility(payload, supportedEndpoints)
    .routing
}

export function evaluateNativeMessagesCompatibility(
  payload: AnthropicMessagesPayload,
  supportedEndpoints: Array<string> | undefined,
): NativeMessagesCompatibilityResult {
  if (state.nativeMessages !== true)
    return { routing: "native_disabled", rejectionReasons: [] }
  if (!supportedEndpoints?.includes("/v1/messages"))
    return { routing: "model_not_advertised", rejectionReasons: [] }
  const rejectionReasons = nativeMessagesRejectionReasons(payload)
  return rejectionReasons.length > 0 ?
      { routing: "request_unsupported", rejectionReasons }
    : { routing: "native_selected", rejectionReasons: [] }
}

export function nativeMessagesRejectionReasons(
  payload: AnthropicMessagesPayload,
): Array<NativeMessagesRejectionReason> {
  const reasons: Array<NativeMessagesRejectionReason> = []
  const effort = payload.output_config?.effort
  if (hasTypedTools(payload.tools)) reasons.push("typed_tools")
  if (payload.mcp_servers && payload.mcp_servers.length > 0)
    reasons.push("mcp_servers")
  if (payload.container) reasons.push("container")
  if (payload.context_management) reasons.push("context_management")
  if (payload.output_config?.format) reasons.push("output_format")
  if (effort === "xhigh" || effort === "max") reasons.push("effort_unsupported")
  reasons.push(...nativeMessageContentRejections(payload))
  if (!Number.isFinite(payload.max_tokens) || payload.max_tokens <= 0)
    reasons.push("max_tokens_invalid")
  return reasons
}

function mapToolResultContent(
  content: AnthropicToolResultBlock["content"],
  map: ToolNameMap,
): AnthropicToolResultBlock["content"] {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (block.type !== "tool_reference") return block
    return {
      ...block,
      tool_name: toOpenAIToolName(block.tool_name, map),
    }
  })
}

function mapUserBlock(
  block: AnthropicUserContentBlock,
  map: ToolNameMap,
): AnthropicUserContentBlock {
  if (block.type === "tool_reference") {
    return {
      ...block,
      tool_name: toOpenAIToolName(block.tool_name, map),
    }
  }
  if (block.type !== "tool_result") return block
  return {
    ...block,
    content: mapToolResultContent(block.content, map),
  }
}

function mapAssistantBlock(
  block: AnthropicAssistantContentBlock,
  map: ToolNameMap,
): AnthropicAssistantContentBlock {
  if (block.type !== "tool_use") return block
  if (!isRecord(block.input))
    invalidNativeRequest("Native Messages tool input must be an object.")
  return {
    ...block,
    name: toOpenAIToolName(block.name, map),
  }
}

// eslint-disable-next-line complexity -- Field-preserving mapper keeps each optional Anthropic request field explicit.
export function buildNativeMessagesBody(
  payload: AnthropicMessagesPayload,
  map: ToolNameMap,
): Record<string, unknown> {
  const messages = payload.messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    if (message.role === "assistant") {
      return {
        ...message,
        content: message.content.map((block) => mapAssistantBlock(block, map)),
      }
    }
    return {
      ...message,
      content: message.content.map((block) => mapUserBlock(block, map)),
    }
  })
  const tools = payload.tools?.map((tool) => {
    if (!("input_schema" in tool) || typeof tool.name !== "string")
      throw new Error("Typed tools are not eligible for native Messages")
    const name = toOpenAIToolName(tool.name, map)
    return {
      ...tool,
      name,
      input_schema: map.inputSchemas?.[name] ?? tool.input_schema,
    }
  })
  const forcedToolName = payload.tool_choice?.name
  const toolChoice =
    payload.tool_choice?.type === "tool" && forcedToolName ?
      {
        ...payload.tool_choice,
        name: toOpenAIToolName(forcedToolName, map),
      }
    : payload.tool_choice

  return {
    model: payload.model,
    messages,
    max_tokens: payload.max_tokens,
    ...(payload.system !== undefined ? { system: payload.system } : {}),
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(payload.stop_sequences !== undefined ?
      { stop_sequences: payload.stop_sequences }
    : {}),
    stream: true,
    ...(payload.temperature !== undefined ?
      { temperature: payload.temperature }
    : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.top_k !== undefined ? { top_k: payload.top_k } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(payload.thinking !== undefined ? { thinking: payload.thinking } : {}),
    ...(payload.service_tier !== undefined ?
      { service_tier: payload.service_tier }
    : {}),
    ...(payload.output_config?.effort !== undefined ?
      { output_config: { effort: payload.output_config.effort } }
    : {}),
    ...((
      payload.context_management !== null
      && payload.context_management !== undefined
    ) ?
      { context_management: payload.context_management }
    : {}),
    ...(payload.speed !== undefined ? { speed: payload.speed } : {}),
    ...(payload.cache_control !== undefined ?
      { cache_control: payload.cache_control }
    : {}),
    ...(payload.inference_geo !== undefined ?
      { inference_geo: payload.inference_geo }
    : {}),
  }
}

function nativeRequestShape(
  body: Record<string, unknown>,
  oneShot: boolean,
): FinalUpstreamRequestShape {
  const candidate = body.max_tokens
  return {
    endpoint: "messages",
    tokenField: Object.hasOwn(body, "max_tokens") ? "max_tokens" : "absent",
    tokenValue:
      typeof candidate === "number" && Number.isFinite(candidate) ?
        candidate
      : null,
    stream: typeof body.stream === "boolean" ? body.stream : null,
    oneShot,
    nativeRouting: "native_selected",
  }
}

function mapNativeStopReason(
  reason: AnthropicResponse["stop_reason"],
): "stop" | "length" | "tool_calls" | "content_filter" {
  if (reason === "max_tokens" || reason === "model_context_window_exceeded")
    return "length"
  if (reason === "tool_use") return "tool_calls"
  if (reason === "refusal") return "content_filter"
  if (
    reason === "end_turn"
    || reason === "stop_sequence"
    || reason === "pause_turn"
  )
    return "stop"
  return invalidNativeResponse("Native Messages response omitted stop_reason")
}

function isNativeTruncation(reason: AnthropicResponse["stop_reason"]): boolean {
  return reason === "max_tokens" || reason === "model_context_window_exceeded"
}

function attachNativeMessagesResponse(
  response: ChatCompletionResponse,
  native: AnthropicResponse,
): ChatCompletionResponse {
  Object.defineProperty(response, nativeMessagesResponse, {
    value: native,
    enumerable: false,
  })
  return response
}

export function getNativeMessagesResponse(
  response: ChatCompletionResponse,
): AnthropicResponse | undefined {
  return (
    response as {
      [nativeMessagesResponse]?: AnthropicResponse
    }
  )[nativeMessagesResponse]
}

export function hasNativeMessagesThinking(
  response: ChatCompletionResponse,
): boolean {
  return Boolean(
    getNativeMessagesResponse(response)?.content.some(
      (block) =>
        block.type === "thinking" || block.type === "redacted_thinking",
    ),
  )
}

function ensureNativeResponse(value: unknown): AnthropicResponse {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || value.type !== "message"
    || value.role !== "assistant"
    || typeof value.model !== "string"
    || !Array.isArray(value.content)
    || !isRecord(value.usage)
    || typeof value.usage.input_tokens !== "number"
    || typeof value.usage.output_tokens !== "number"
  ) {
    invalidNativeResponse("Native Messages response shape was invalid")
  }
  for (const block of value.content) {
    if (
      !isRecord(block)
      || !["redacted_thinking", "text", "thinking", "tool_use"].includes(
        String(block.type),
      )
    ) {
      invalidNativeResponse("Native Messages returned an unsupported block")
    }
  }
  return value as unknown as AnthropicResponse
}

function adaptNativeResponse(
  value: unknown,
  shape: FinalUpstreamRequestShape,
  rawToolArguments?: Map<number, string>,
): ChatCompletionResponse {
  const native = ensureNativeResponse(value)
  const text = native.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
  const toolBlocks = native.content.filter((block) => block.type === "tool_use")
  const toolCalls = toolBlocks.map((block, index) => ({
    id: block.id,
    type: "function" as const,
    function: {
      name: block.name,
      arguments: rawToolArguments?.get(index) ?? JSON.stringify(block.input),
    },
  }))
  const cacheRead = native.usage.cache_read_input_tokens ?? 0
  const cacheCreation = native.usage.cache_creation_input_tokens ?? 0
  const response: ChatCompletionResponse = {
    id: native.id,
    object: "chat.completion",
    created: 0,
    model: native.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(native.stop_reason === "refusal" ? { refusal: text } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: mapNativeStopReason(native.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: native.usage.input_tokens + cacheRead + cacheCreation,
      completion_tokens: native.usage.output_tokens,
      total_tokens:
        native.usage.input_tokens
        + cacheRead
        + cacheCreation
        + native.usage.output_tokens,
      ...(cacheRead > 0 || cacheCreation > 0 ?
        {
          prompt_tokens_details: {
            cached_tokens: cacheRead,
            cache_creation_tokens: cacheCreation,
          },
        }
      : {}),
    },
  }
  attachFinalUpstreamRequestShape(response, shape)
  if (
    !isNativeTruncation(native.stop_reason)
    && native.stop_reason !== "refusal"
  ) {
    attachNativeMessagesResponse(response, native)
  }
  return response
}

interface PartialNativeBlock {
  block: Record<string, unknown>
  arguments?: string
  stopped: boolean
}

class NativeStreamCollector {
  private readonly blocks = new Map<number, PartialNativeBlock>()
  private message: Record<string, unknown> | undefined
  private messageDeltaUsage: Record<string, number> = {}
  private messageDeltaSeen = false
  private openBlockIndex: number | undefined
  private outputTokens: unknown
  private stopReason: unknown
  private stopSequence: unknown = null
  private stopped = false

  // eslint-disable-next-line complexity, max-lines-per-function -- Protocol transitions stay centralized so invalid event order cannot bypass validation.
  accept(event: NativeStreamEvent): boolean {
    if (this.stopped)
      invalidNativeResponse("Native Messages emitted data after message_stop")
    const type = event.type
    if (type === "ping") return false
    if (type === "error")
      throw new HTTPError(
        "Native Messages stream failed",
        Response.json(event, { status: 502 }),
      )
    if (type === "message_start") {
      if (this.message || !isRecord(event.message))
        invalidNativeResponse("Invalid message_start")
      this.message = event.message
      return false
    }
    if (type === "content_block_start") {
      if (
        !this.message
        || this.messageDeltaSeen
        || this.openBlockIndex !== undefined
        || typeof event.index !== "number"
        || !isRecord(event.content_block)
        || this.blocks.has(event.index)
        || event.index !== this.blocks.size
      )
        invalidNativeResponse("Invalid content_block_start")
      const block = { ...event.content_block }
      const blockType = block.type
      if (
        (blockType === "text" && typeof block.text !== "string")
        || (blockType === "thinking" && typeof block.thinking !== "string")
        || (blockType === "redacted_thinking" && typeof block.data !== "string")
        || (blockType === "tool_use"
          && (typeof block.id !== "string"
            || typeof block.name !== "string"
            || !isRecord(block.input)))
        || !["redacted_thinking", "text", "thinking", "tool_use"].includes(
          String(blockType),
        )
      )
        invalidNativeResponse("Invalid native content block")
      this.blocks.set(event.index, { block, stopped: false })
      this.openBlockIndex = event.index
      return false
    }
    if (type === "content_block_delta") {
      if (
        this.messageDeltaSeen
        || typeof event.index !== "number"
        || event.index !== this.openBlockIndex
        || !isRecord(event.delta)
      )
        invalidNativeResponse("Invalid content_block_delta")
      const current = this.blocks.get(event.index)
      if (!current || current.stopped)
        invalidNativeResponse("Delta preceded block start")
      const deltaType = event.delta.type
      if (
        current.block.type === "text"
        && deltaType === "text_delta"
        && typeof event.delta.text === "string"
      ) {
        const text =
          typeof current.block.text === "string" ? current.block.text : ""
        current.block.text = text + event.delta.text
      } else if (
        current.block.type === "thinking"
        && deltaType === "thinking_delta"
        && typeof event.delta.thinking === "string"
      ) {
        const thinking =
          typeof current.block.thinking === "string" ?
            current.block.thinking
          : ""
        current.block.thinking = thinking + event.delta.thinking
      } else if (
        current.block.type === "thinking"
        && deltaType === "signature_delta"
        && typeof event.delta.signature === "string"
      ) {
        const signature =
          typeof current.block.signature === "string" ?
            current.block.signature
          : ""
        current.block.signature = signature + event.delta.signature
      } else if (
        current.block.type === "tool_use"
        && deltaType === "input_json_delta"
        && typeof event.delta.partial_json === "string"
      ) {
        if (
          current.arguments === undefined
          && Object.keys(current.block.input as Record<string, unknown>).length
            > 0
        )
          invalidNativeResponse(
            "Native tool input was split across incompatible representations",
          )
        current.arguments = (current.arguments ?? "") + event.delta.partial_json
      } else if (
        current.block.type === "text"
        && deltaType === "citations_delta"
        && event.delta.citation !== undefined
      ) {
        const citations =
          Array.isArray(current.block.citations) ? current.block.citations : []
        citations.push(event.delta.citation)
        current.block.citations = citations
      } else {
        invalidNativeResponse("Native Messages returned an unsupported delta")
      }
      return false
    }
    if (type === "content_block_stop") {
      if (
        typeof event.index !== "number"
        || event.index !== this.openBlockIndex
      )
        invalidNativeResponse("Invalid content_block_stop")
      const current = this.blocks.get(event.index)
      if (!current || current.stopped)
        invalidNativeResponse("Invalid content_block_stop")
      current.stopped = true
      this.openBlockIndex = undefined
      return false
    }
    if (type === "message_delta") {
      if (
        !this.message
        || this.messageDeltaSeen
        || this.openBlockIndex !== undefined
        || [...this.blocks.values()].some((entry) => !entry.stopped)
        || !isRecord(event.delta)
      )
        invalidNativeResponse("Invalid message_delta")
      this.messageDeltaSeen = true
      this.stopReason = event.delta.stop_reason
      this.stopSequence = event.delta.stop_sequence ?? null
      if (isRecord(event.usage)) {
        this.outputTokens = event.usage.output_tokens
        this.messageDeltaUsage = Object.fromEntries(
          Object.entries(event.usage).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && Number.isFinite(entry[1]),
          ),
        )
      }
      return false
    }
    if (type === "message_stop") {
      if (
        !this.messageDeltaSeen
        || this.openBlockIndex !== undefined
        || [...this.blocks.values()].some((entry) => !entry.stopped)
      )
        invalidNativeResponse("Invalid message_stop")
      this.stopped = true
      return true
    }
    invalidNativeResponse("Native Messages returned an unsupported event")
    return false
  }

  finish(): {
    response: AnthropicResponse
    rawToolArguments: Map<number, string>
  } {
    if (
      !this.message
      || !this.stopped
      || typeof this.stopReason !== "string"
      || typeof this.outputTokens !== "number"
      || !Number.isFinite(this.outputTokens)
      || !isRecord(this.message.usage)
    )
      invalidNativeResponse("Native Messages stream ended incompletely")

    const rawToolArguments = new Map<number, string>()
    let toolIndex = 0
    const content = [...this.blocks.values()].map((entry) => {
      if (entry.block.type !== "tool_use") return entry.block
      const startInput = entry.block.input as Record<string, unknown>
      const argumentsJson = entry.arguments ?? JSON.stringify(startInput)
      rawToolArguments.set(toolIndex, argumentsJson)
      toolIndex++
      if (entry.arguments === undefined) return entry.block
      try {
        const input: unknown = JSON.parse(entry.arguments)
        if (!isRecord(input))
          throw new TypeError("Tool input must be an object")
        return { ...entry.block, input }
      } catch {
        if (
          this.stopReason !== "max_tokens"
          && this.stopReason !== "model_context_window_exceeded"
          && this.stopReason !== "refusal"
        )
          invalidNativeResponse(
            "Native Messages completed with malformed tool input",
          )
        return entry.block
      }
    })
    return {
      response: ensureNativeResponse({
        ...this.message,
        content,
        stop_reason: this.stopReason,
        stop_sequence: this.stopSequence,
        usage: {
          ...this.message.usage,
          ...this.messageDeltaUsage,
          output_tokens: this.outputTokens,
        },
      }),
      rawToolArguments,
    }
  }
}

function attachBufferedNativeResponse(
  event: ServerSentEventMessage,
  response: ChatCompletionResponse,
): ServerSentEventMessage {
  Object.defineProperty(event, bufferedNativeResponse, {
    value: response,
    enumerable: false,
  })
  return event
}

export function getBufferedNativeResponse(
  event: ServerSentEventMessage,
): ChatCompletionResponse | undefined {
  return (
    event as {
      [bufferedNativeResponse]?: ChatCompletionResponse
    }
  )[bufferedNativeResponse]
}

async function nativeFetch(
  payload: AnthropicMessagesPayload,
  map: ToolNameMap,
  signal?: AbortSignal,
): Promise<ChatCompletionResponse | AsyncGenerator<ServerSentEventMessage>> {
  const body = buildNativeMessagesBody(payload, map)
  const shape = nativeRequestShape(body, signal !== undefined)
  const inactivity = createInactivityAbort()
  const downstream = requestSignal()
  const signals = [inactivity.signal, signal, downstream].filter(
    (entry): entry is AbortSignal => entry !== undefined,
  )
  const combined = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  combined.throwIfAborted()
  const response = await fetchWithInactivity(
    `${copilotBaseUrl(state)}/v1/messages`,
    {
      method: "POST",
      headers: {
        ...copilotHeaders(state),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: combined,
      // @ts-expect-error — Bun-specific option
      timeout: false,
    },
    inactivity,
  )
  inactivity.keepAlive()
  if (!response.ok) {
    inactivity.clear()
    throw new HTTPError("Failed to create native Messages completion", response)
  }

  async function collect(): Promise<ChatCompletionResponse> {
    const collector = new NativeStreamCollector()
    // SSE framing can be much larger than the decoded content when providers
    // emit many small deltas, so this is a wire ceiling rather than a
    // bytes-per-token estimate.
    const maxBytes = 32 * 1024 * 1024
    const encoder = new TextEncoder()
    let receivedBytes = 0
    for await (const event of responseEvents(response, combined)) {
      inactivity.keepAlive()
      if (!event.data || event.data === "[DONE]") continue
      receivedBytes += encoder.encode(event.data).byteLength
      if (receivedBytes > maxBytes)
        invalidNativeResponse("Native Messages stream exceeded its size limit")
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        invalidNativeResponse("Native Messages stream contained invalid JSON")
      }
      if (!isRecord(parsed))
        invalidNativeResponse("Native Messages stream event was invalid")
      if (collector.accept(parsed)) break
    }
    const collected = collector.finish()
    return adaptNativeResponse(
      collected.response,
      shape,
      collected.rawToolArguments,
    )
  }

  if (payload.stream === true && signal === undefined) {
    async function* buffered() {
      try {
        yield attachBufferedNativeResponse({ data: "" }, await collect())
      } finally {
        inactivity.clear()
      }
    }
    const stream = buffered()
    attachFinalUpstreamRequestShape(stream, shape)
    return stream
  }

  try {
    return await collect()
  } finally {
    inactivity.clear()
  }
}

export async function createNativeMessagesCompletion(
  payload: AnthropicMessagesPayload,
  map: ToolNameMap,
  signal?: AbortSignal,
): Promise<ChatCompletionResponse | AsyncGenerator<ServerSentEventMessage>> {
  return nativeFetch(payload, map, signal)
}

export function restoreNativeMessagesResponse(
  translated: AnthropicResponse,
  response: ChatCompletionResponse,
  map: ToolNameMap | undefined,
): AnthropicResponse {
  const native = getNativeMessagesResponse(response)
  if (!native) return translated
  if (
    translated.stop_reason !== native.stop_reason
    || translated.stop_reason === "refusal"
  )
    return translated
  const nativeTools = native.content.filter(
    (block) => block.type === "tool_use",
  )
  const translatedTools = translated.content.filter(
    (block) => block.type === "tool_use",
  )
  if (
    nativeTools.length !== translatedTools.length
    || nativeTools.some((block, index) => {
      const translatedBlock = translatedTools[index]
      const identity = toAnthropicToolIdentity(block.name, map)
      return (
        translatedBlock.id !== block.id
        || translatedBlock.name !== identity.name
        || translatedBlock.toolset_name !== identity.toolset_name
        || JSON.stringify(translatedBlock.input) !== JSON.stringify(block.input)
      )
    })
  )
    return translated
  return {
    ...native,
    content: native.content.map((block) => {
      if (block.type !== "tool_use") return block
      return {
        ...block,
        ...toAnthropicToolIdentity(block.name, map),
      }
    }),
  }
}
