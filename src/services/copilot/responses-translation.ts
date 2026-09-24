/* eslint-disable max-lines */
/**
 * Translation helpers between OpenAI Chat Completions format and Responses API format.
 */

import type { SSEMessage } from "hono/streaming"

import consola from "consola"

import {
  HTTPError,
  extractUpstreamErrorMessage,
  isContextWindowError,
} from "~/lib/error"
import { repairOrphanedToolCalls } from "~/lib/tool-call-repair"
import { invalidToolInput, parseToolInput } from "~/routes/messages/tool-input"

import type {
  ContentPart,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Tool,
  ToolCall,
} from "./create-chat-completions"
import type { Model, ModelsResponse } from "./get-models"

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
  /**
   * The OpenAI Responses API accepts either a plain string (shorthand for a
   * single user message) or an array of typed input items.  Both forms are
   * sent in practice — the ChatGPT desktop app and Codex use the string form
   * for simple turns — so the union must be modeled here.
   */
  input: string | Array<ResponsesInputItem>
  instructions?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean | null
  tools?: Array<ResponsesTool>
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; name: string }
  parallel_tool_calls?: boolean
  reasoning?: ChatCompletionsPayload["reasoning"]
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
  // `type: "message"` is optional: the Responses API accepts a bare
  // `{role, content}` item, but the ChatGPT desktop app and Codex send the
  // explicit tagged form.  Both are handled at runtime, so both are modeled.
  | {
      type?: "message"
      role: string
      content: string | Array<ResponsesContentPart>
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }

// ─── Responses API response types ────────────────────────────────────────────

interface ResponsesOutputMessage {
  type: "message"
  role: "assistant"
  content: Array<{ type: string; text?: string; refusal?: string }>
}

interface ResponsesFunctionCall {
  id?: string
  type: "function_call"
  status?: "in_progress" | "completed" | "incomplete"
  call_id: string
  name: string
  arguments: string
}

type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesFunctionCall
  | { type: "reasoning"; summary?: Array<{ text?: string }> }

interface ResponsesResponse {
  id: string
  model: string
  status?: string
  incomplete_details?: { reason?: string }
  error?: unknown
  output: Array<ResponsesOutputItem>
  usage: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens: number }
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

function buildResponsesTools(
  tools: NonNullable<ChatCompletionsPayload["tools"]>,
): Array<ResponsesTool> {
  return tools.map((tool) => ({
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
}

/** True when a value is neither null nor undefined (narrows the type). */
function isSet<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined
}

function buildOptionalScalars(
  payload: ChatCompletionsPayload,
): Partial<ResponsesPayload> {
  const out: Partial<ResponsesPayload> = {}
  if (isSet(payload.parallel_tool_calls))
    out.parallel_tool_calls = payload.parallel_tool_calls
  if (isSet(payload.max_tokens)) out.max_output_tokens = payload.max_tokens
  if (isSet(payload.temperature)) out.temperature = payload.temperature
  if (isSet(payload.top_p)) out.top_p = payload.top_p
  if (isSet(payload.stream)) out.stream = payload.stream
  if (isSet(payload.tools)) out.tools = buildResponsesTools(payload.tools)
  if (isSet(payload.tool_choice) && out.tools && out.tools.length > 0)
    out.tool_choice =
      typeof payload.tool_choice === "object" ?
        { type: "function", name: payload.tool_choice.function.name }
      : payload.tool_choice
  // Forward reasoning controls (effort + summary). `summary: "auto"` is what
  // makes Copilot stream reasoning_summary_text.delta events in real time so
  // the thinking block renders incrementally instead of all at once.
  if (isSet(payload.reasoning)) out.reasoning = payload.reasoning
  if (isSet(payload.reasoning_effort)) {
    out.reasoning = { ...out.reasoning, effort: payload.reasoning_effort }
  }
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

// ─── Routing helper: models that don't support the Responses API ─────────────
// Allow-list approach: only models known to support /responses go direct.
// Everything else is routed through /chat/completions.
const RESPONSES_API_PREFIXES = ["gpt-4.1", "gpt-5", "gpt-6", "o1", "o3", "o4"]

const RESPONSES_API_EXACT = new Set(["gpt-41-copilot"])

/**
 * Decides whether a model must be served by translating to Chat Completions
 * rather than passing the Responses payload through natively.
 *
 * Prefers the catalog's own `supported_endpoints` capability data, falling back
 * to the hardcoded name list only when the catalog is unavailable or silent.
 * The list alone is a maintenance hazard: a model Copilot serves natively on
 * `/responses` but whose name doesn't match a known prefix would be silently
 * downgraded to the lossy translation path (which drops `parallel_tool_calls`,
 * built-in tools, and emits a reduced event set).
 */
export function requiresChatCompletionsApi(
  model: string,
  models?: ModelsResponse,
): boolean {
  const catalogEntry = models?.data.find((m) => m.id === model)
  const endpoints = catalogEntry?.supported_endpoints
  if (endpoints && endpoints.length > 0) {
    // Native passthrough whenever the model genuinely serves /responses.
    if (endpoints.includes("/responses")) return false
    if (endpoints.includes("/chat/completions")) return true
  }

  if (RESPONSES_API_EXACT.has(model)) return false
  if (RESPONSES_API_PREFIXES.some((p) => model.startsWith(p))) return false
  return true
}

// ─── Payload translation: Responses API → Chat Completions ──────────────────
export function translateFromResponsesPayloadToCC(
  payload: ResponsesPayload,
): ChatCompletionsPayload {
  const messages: Array<import("./create-chat-completions").Message> = []

  if (payload.instructions) {
    messages.push({ role: "system", content: payload.instructions })
  }

  // `input` is either a plain string (shorthand for a single user message) or
  // an array of input items.  Iterating a string yields its *characters*, each
  // of which translates to nothing — producing an empty `messages` array and a
  // hard `400 messages must be non-empty` from upstream.  The ChatGPT desktop
  // app and Codex both send the string form for simple turns.
  if (typeof payload.input === "string") {
    if (payload.input.length > 0) {
      messages.push({ role: "user", content: payload.input })
    }
  } else {
    for (const item of payload.input) {
      const msg = translateInputItemToMessage(item)
      if (msg) messages.push(msg)
    }
  }

  repairOrphanedToolCalls(messages)

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
  if (payload.reasoning !== undefined) {
    // Preserve Copilot's reasoning extension (summary and other controls) as
    // well as the standard Chat Completions effort field.
    result.reasoning = payload.reasoning
    if (payload.reasoning?.effort !== undefined) {
      result.reasoning_effort = payload.reasoning.effort
    }
  }

  applyToolsAndFormat(payload, result)

  if (
    payload.tool_choice !== undefined
    && result.tools
    && result.tools.length > 0
  )
    result.tool_choice =
      typeof payload.tool_choice === "object" ?
        { type: "function", function: { name: payload.tool_choice.name } }
      : payload.tool_choice
}

function applyToolsAndFormat(
  payload: ResponsesPayload,
  result: ChatCompletionsPayload,
): void {
  if (payload.tools && payload.tools.length > 0) {
    const ccTools = payload.tools.flatMap((t) => responsesToolToCC(t))
    if (ccTools.length > 0) {
      result.tools = ccTools
    } else {
      // Every tool was a built-in the Chat Completions API cannot express
      // (web_search, file_search, code_interpreter, image_generation, mcp, …).
      // The model is then told nothing about them and may claim capabilities it
      // lacks, so make the drop visible rather than silent.
      consola.debug(
        `[responses→cc] All ${payload.tools.length} tool(s) dropped — no Chat `
          + `Completions equivalent: ${payload.tools.map((t) => t.type).join(", ")}`,
      )
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

/**
 * Translates a single Responses-API tool into zero or more Chat Completions
 * tools.
 *
 * Returns an array because a `namespace` tool is a *container* of functions and
 * expands to one CC tool per member.
 */
function responsesToolToCC(t: ResponsesTool): Array<Tool> {
  if (t.type === "function" && t.name) {
    return [
      {
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? {},
          ...(t.strict !== undefined && { strict: t.strict }),
        },
      },
    ]
  }
  if (t.type === "local_shell") {
    return [
      {
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
      },
    ]
  }
  if (t.type === "custom" && t.name) {
    // Includes Codex's `freeform` tools, whose grammar lives in `format` and
    // has no Chat Completions equivalent — the callable name and description
    // are preserved so the model can still invoke it.
    return [
      {
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? {},
        },
      },
    ]
  }
  if (t.type === "namespace") {
    // Codex groups related tools under a namespace container
    // (codex-rs/tools/src/responses_api.rs → `ResponsesApiNamespace`).  The
    // member functions are the real callable tools; dropping the container
    // silently discards all of them, leaving the model unaware of capabilities
    // it was told it had.  Flatten to `namespace__member` to avoid collisions
    // between same-named tools in different namespaces.
    const members = Array.isArray(t.tools) ? (t.tools as Array<unknown>) : []
    return members.flatMap((raw) => {
      if (raw === null || typeof raw !== "object") return []
      const member = raw as ResponsesTool
      if (!member.name) return []
      return [
        {
          type: "function" as const,
          function: {
            name: t.name ? `${t.name}__${member.name}` : member.name,
            description: member.description,
            parameters: member.parameters ?? {},
            ...(member.strict !== undefined && { strict: member.strict }),
          },
        },
      ]
    })
  }
  return []
}

function translateResponsesContentToCC(
  content: string | Array<ResponsesContentPart> | null | undefined,
): string | Array<ContentPart> | null {
  if (content === null || content === undefined) return null
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
type CCResponseChoice = ChatCompletionResponse["choices"][number]

function ccResponseStatus(choice: CCResponseChoice): {
  incomplete: boolean
  refused: boolean
  status: "completed" | "incomplete"
} {
  const refused =
    choice.message.refusal !== undefined && choice.message.refusal !== null
  const incomplete =
    choice.finish_reason === "length"
    || (choice.finish_reason === "content_filter" && !refused)
  return {
    incomplete,
    refused,
    status: incomplete ? "incomplete" : "completed",
  }
}

function ccResponseMessageOutput(options: {
  choice: CCResponseChoice
  id: string
  refused: boolean
  status: "completed" | "incomplete"
}): Array<Record<string, unknown>> {
  const { choice, id, refused, status } = options
  const output: Array<Record<string, unknown>> = []
  const reasoning =
    choice.message.reasoning_content ?? choice.message.reasoning_text
  if (reasoning)
    output.push({
      id: `${id}_reasoning`,
      type: "reasoning",
      status,
      summary: [{ type: "summary_text", text: reasoning }],
    })
  const content: Array<Record<string, unknown>> = []
  if (choice.message.content)
    content.push({ type: "output_text", text: choice.message.content })
  if (refused)
    content.push({ type: "refusal", refusal: choice.message.refusal })
  if (content.length > 0)
    output.push({
      id: `${id}_message`,
      type: "message",
      status,
      role: "assistant",
      content,
    })
  return output
}

function normalizeBufferedCCArguments(
  toolCall: ToolCall,
  contract: CCToolContract | undefined,
): string {
  let argumentsJson = toolCall.function.arguments
  if (contract?.noInput && argumentsJson === "") {
    consola.warn("[responses→cc] normalized omitted tool arguments", {
      reason: "completed_declared_no_input",
      argumentPresence: "empty",
      argumentJsonClass: "empty",
      argumentByteCount: 0,
      idPresent: toolCall.id.length > 0,
      nameResolved: true,
      schemaNoInput: true,
    })
    argumentsJson = "{}"
  }
  parseToolInput(argumentsJson, toolCall.function.name, contract?.schema)
  return argumentsJson
}

function ccResponseToolOutput(options: {
  choice: CCResponseChoice
  incomplete: boolean
  refused: boolean
  status: "completed" | "incomplete"
  tools: Array<ResponsesTool> | undefined
}): Array<ResponsesFunctionCall> {
  const { choice, incomplete, refused, status, tools } = options
  if (!choice.message.tool_calls || refused) return []
  const contracts = buildCCToolContracts(tools)
  return choice.message.tool_calls.map((toolCall) => {
    const contract = contracts.get(toolCall.function.name)
    if (!contract)
      throw invalidToolInput(
        toolCall.function.name,
        "tool name is not declared by the request",
      )
    const argumentsJson =
      incomplete ?
        toolCall.function.arguments
      : normalizeBufferedCCArguments(toolCall, contract)
    return {
      id: toolCall.id,
      type: "function_call",
      status,
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: argumentsJson,
    }
  })
}

function ccResponseUsage(
  usage: ChatCompletionResponse["usage"],
): ResponsesResponse["usage"] {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    ...(cachedTokens !== undefined ?
      { input_tokens_details: { cached_tokens: cachedTokens } }
    : {}),
  }
}

export function translateFromCCToResponsesResponse(
  resp: ChatCompletionResponse,
  responsesId?: string,
  tools?: Array<ResponsesTool>,
): Record<string, unknown> {
  const id = responsesId ?? `resp_${Date.now()}`
  if (resp.choices.length !== 1)
    throw invalidToolInput(
      "response",
      "upstream returned an invalid choice count",
    )
  const choice = resp.choices[0]

  const { incomplete, refused, status } = ccResponseStatus(choice)
  const output = ccResponseMessageOutput({ choice, id, status, refused })
  const validatedCalls = ccResponseToolOutput({
    choice,
    tools,
    status,
    incomplete,
    refused,
  })
  if (
    !incomplete
    && !refused
    && ((choice.finish_reason === "tool_calls" && validatedCalls.length === 0)
      || (choice.finish_reason === "stop" && validatedCalls.length > 0))
  )
    throw invalidToolInput(
      "response",
      "finish reason conflicts with tool-call output",
    )
  output.push(...validatedCalls.map((call) => ({ ...call })))

  return {
    id,
    object: "response",
    model: resp.model,
    status,
    ...(incomplete ?
      {
        incomplete_details: {
          reason:
            choice.finish_reason === "length" ?
              "max_output_tokens"
            : "content_filter",
        },
      }
    : {}),
    output,
    usage: ccResponseUsage(resp.usage),
  }
}

// ─── Stream translation: CC SSE chunk → Responses API SSE events ────────────
export interface CCToResponsesStreamState {
  responseId: string
  model: string
  sequenceNumber: number
  nextOutputIndex: number
  outputOrder: Array<
    | { kind: "message"; outputIndex: number }
    | { kind: "reasoning"; outputIndex: number }
    | { kind: "tool"; outputIndex: number; toolIndex: number }
  >
  messageOutputIndex?: number
  reasoningOutputIndex?: number
  pendingToolCalls: Map<number, PendingCCToolCall>
  toolContracts: Map<string, CCToolContract>
  usage: ResponsesResponse["usage"]
  accumulatedText: string
  accumulatedReasoningText: string
  accumulatedRefusal: string
  sawRefusal: boolean
  finishReason?: CCFinishReason
  upstreamId?: string
  upstreamModel?: string
  terminalEmitted: boolean
}

type CCFinishReason = "stop" | "length" | "tool_calls" | "content_filter"

interface CCToolContract {
  schema: Record<string, unknown>
  noInput: boolean
}

interface PendingCCToolCall {
  outputIndex: number
  idFragments: Array<string>
  nameFragments: Array<string>
  arguments: string
  sawArguments: boolean
}

interface CompletedCCToolCall {
  outputIndex: number
  id: string
  name: string
  arguments: string
}

interface CCToResponsesStreamOptions {
  responseId: string
  model: string
  tools?: Array<ResponsesTool>
}

const EMPTY_PARAMETER_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const

export function createCCToResponsesStreamState(
  options: CCToResponsesStreamOptions,
): CCToResponsesStreamState {
  return {
    responseId: options.responseId,
    model: options.model,
    sequenceNumber: 0,
    nextOutputIndex: 0,
    outputOrder: [],
    pendingToolCalls: new Map(),
    toolContracts: buildCCToolContracts(options.tools),
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    accumulatedText: "",
    accumulatedReasoningText: "",
    accumulatedRefusal: "",
    sawRefusal: false,
    terminalEmitted: false,
  }
}

interface ResponsesSSEEvent {
  event: string
  data: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalidCCStream(reason: string): HTTPError {
  return invalidToolInput("response", reason)
}

export function invalidCCToResponsesFrame(): HTTPError {
  return invalidCCStream("upstream stream contained malformed JSON")
}

function isClosedEmptyObjectSchema(schema: Record<string, unknown>): boolean {
  const allowed = new Set([
    "$schema",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "title",
    "description",
    "default",
    "examples",
  ])
  const properties = schema.properties
  const required = schema.required
  return (
    schema.type === "object"
    && isRecord(properties)
    && Object.keys(properties).length === 0
    && (required === undefined
      || (Array.isArray(required) && required.length === 0))
    && schema.additionalProperties === false
    && Object.keys(schema).every((key) => allowed.has(key))
  )
}

function addCCToolContract(options: {
  contracts: Map<string, CCToolContract>
  name: string
  omittedParameters: boolean
  parameters: Record<string, unknown> | undefined
}): void {
  const { contracts, name, omittedParameters, parameters } = options
  if (contracts.has(name))
    throw invalidCCStream("declared tool names collide after translation")
  contracts.set(name, {
    schema:
      omittedParameters ? { ...EMPTY_PARAMETER_SCHEMA } : (parameters ?? {}),
    noInput:
      omittedParameters
      || (parameters !== undefined && isClosedEmptyObjectSchema(parameters)),
  })
}

function buildCCToolContracts(
  tools: Array<ResponsesTool> | undefined,
): Map<string, CCToolContract> {
  const contracts = new Map<string, CCToolContract>()
  for (const tool of tools ?? []) {
    if (tool.type === "function" && tool.name) {
      addCCToolContract({
        contracts,
        name: tool.name,
        parameters: tool.parameters,
        omittedParameters: tool.parameters === undefined,
      })
      continue
    }
    if (tool.type === "custom" && tool.name) {
      addCCToolContract({
        contracts,
        name: tool.name,
        parameters: tool.parameters,
        omittedParameters: false,
      })
      continue
    }
    if (tool.type === "local_shell") {
      const translated = responsesToolToCC(tool)[0]
      addCCToolContract({
        contracts,
        name: translated.function.name,
        parameters: translated.function.parameters,
        omittedParameters: false,
      })
      continue
    }
    if (tool.type !== "namespace") continue
    const members = Array.isArray(tool.tools) ? tool.tools : []
    for (const raw of members) {
      if (!isRecord(raw) || typeof raw.name !== "string") continue
      const memberName = raw.name
      const member = raw as ResponsesTool
      const name = tool.name ? `${tool.name}__${memberName}` : memberName
      addCCToolContract({
        contracts,
        name,
        parameters: member.parameters,
        omittedParameters: member.parameters === undefined,
      })
    }
  }
  return contracts
}

function nextEvent(
  streamState: CCToResponsesStreamState,
  event: string,
  data: Record<string, unknown>,
): ResponsesSSEEvent {
  return {
    event,
    data: JSON.stringify({
      ...data,
      sequence_number: streamState.sequenceNumber++,
    }),
  }
}

function responseSnapshot(options: {
  incompleteReason?: string
  output?: Array<Record<string, unknown>>
  status: "in_progress" | "completed" | "incomplete"
  streamState: CCToResponsesStreamState
}): Record<string, unknown> {
  const {
    incompleteReason = "max_output_tokens",
    output = [],
    status,
    streamState,
  } = options
  return {
    id: streamState.responseId,
    object: "response",
    model: streamState.model,
    status,
    output,
    ...(status === "incomplete" ?
      { incomplete_details: { reason: incompleteReason } }
    : {}),
    ...(status === "in_progress" ? {} : { usage: streamState.usage }),
  }
}

export function createCCToResponsesInitialEvents(
  streamState: CCToResponsesStreamState,
): Array<ResponsesSSEEvent> {
  const response = responseSnapshot({ streamState, status: "in_progress" })
  return [
    nextEvent(streamState, "response.created", {
      type: "response.created",
      response,
    }),
    nextEvent(streamState, "response.in_progress", {
      type: "response.in_progress",
      response,
    }),
  ]
}

function tokenCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw invalidCCStream(`upstream usage has an invalid ${field}`)
  return value
}

function captureCCUsage(
  value: unknown,
  streamState: CCToResponsesStreamState,
): void {
  if (value === undefined || value === null) return
  if (!isRecord(value)) throw invalidCCStream("upstream usage is invalid")
  const promptDetails = value.prompt_tokens_details
  let cachedTokens: number | undefined
  if (promptDetails !== undefined && promptDetails !== null) {
    if (!isRecord(promptDetails))
      throw invalidCCStream("upstream cached usage is invalid")
    if (promptDetails.cached_tokens !== undefined)
      cachedTokens = tokenCount(
        promptDetails.cached_tokens,
        "cached token count",
      )
  }
  streamState.usage = {
    input_tokens: tokenCount(value.prompt_tokens, "input token count"),
    output_tokens: tokenCount(value.completion_tokens, "output token count"),
    total_tokens: tokenCount(value.total_tokens, "total token count"),
    ...(cachedTokens !== undefined ?
      { input_tokens_details: { cached_tokens: cachedTokens } }
    : {}),
  }
}

function validatedCCChunkIdentity(chunk: Record<string, unknown>): {
  id: string
  model: string
} {
  if (typeof chunk.id !== "string" || chunk.id.length === 0)
    throw invalidCCStream("upstream chunk lacks a response id")
  if (typeof chunk.model !== "string" || chunk.model.length === 0)
    throw invalidCCStream("upstream chunk lacks a model")
  if (
    chunk.object !== undefined
    && chunk.object !== "chat.completion.chunk"
    && chunk.object !== "chat.completion"
  )
    throw invalidCCStream("upstream chunk has an invalid object type")
  if (
    chunk.created !== undefined
    && (typeof chunk.created !== "number" || !Number.isFinite(chunk.created))
  )
    throw invalidCCStream("upstream chunk has an invalid created timestamp")
  return { id: chunk.id, model: chunk.model }
}

function captureCCIdentity(
  chunk: Record<string, unknown>,
  streamState: CCToResponsesStreamState,
): void {
  const { id, model } = validatedCCChunkIdentity(chunk)
  if (streamState.upstreamId && streamState.upstreamId !== id)
    throw invalidCCStream("upstream response id changed mid-stream")
  if (streamState.upstreamModel && streamState.upstreamModel !== model)
    throw invalidCCStream("upstream model changed mid-stream")
  streamState.upstreamId ??= id
  streamState.upstreamModel ??= model
}

function allocateOutput(
  streamState: CCToResponsesStreamState,
  item:
    | { kind: "message" }
    | { kind: "reasoning" }
    | { kind: "tool"; toolIndex: number },
): number {
  const outputIndex = streamState.nextOutputIndex++
  streamState.outputOrder.push({ ...item, outputIndex })
  return outputIndex
}

function appendCCString(
  source: Record<string, unknown>,
  key: string,
  append: (value: string) => void,
): void {
  const value = source[key]
  if (value === undefined) return
  if (typeof value !== "string")
    throw invalidCCStream(`upstream ${key} delta is invalid`)
  append(value)
}

function pendingCCToolCall(
  index: number,
  streamState: CCToResponsesStreamState,
): PendingCCToolCall {
  const existing = streamState.pendingToolCalls.get(index)
  if (existing) return existing
  if (streamState.pendingToolCalls.size >= 128)
    throw invalidCCStream("upstream returned too many tool calls")
  const created: PendingCCToolCall = {
    outputIndex: allocateOutput(streamState, {
      kind: "tool",
      toolIndex: index,
    }),
    idFragments: [],
    nameFragments: [],
    arguments: "",
    sawArguments: false,
  }
  streamState.pendingToolCalls.set(index, created)
  return created
}

function captureCCToolCalls(
  value: unknown,
  streamState: CCToResponsesStreamState,
): void {
  if (value === undefined || value === null) return
  if (!Array.isArray(value))
    throw invalidCCStream("upstream tool-call deltas are invalid")
  for (const raw of value) {
    if (!isRecord(raw))
      throw invalidCCStream("upstream tool-call delta is invalid")
    const index = raw.index
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0)
      throw invalidCCStream("upstream tool-call index is invalid")
    if (raw.type !== undefined && raw.type !== null && raw.type !== "function")
      throw invalidCCStream("upstream tool-call type is unsupported")
    const call = pendingCCToolCall(index, streamState)
    appendCCString(raw, "id", (fragment) => {
      if (fragment) call.idFragments.push(fragment)
    })
    if (raw.function === undefined) continue
    if (!isRecord(raw.function))
      throw invalidCCStream("upstream tool function delta is invalid")
    appendCCString(raw.function, "name", (fragment) => {
      if (fragment) call.nameFragments.push(fragment)
    })
    if (Object.hasOwn(raw.function, "arguments")) {
      if (typeof raw.function.arguments !== "string")
        throw invalidCCStream("upstream tool arguments delta is invalid")
      call.sawArguments = true
      call.arguments += raw.function.arguments
    }
  }
}

function captureCCText(
  delta: Record<string, unknown>,
  streamState: CCToResponsesStreamState,
): void {
  if (
    delta.role !== undefined
    && delta.role !== null
    && delta.role !== "assistant"
  )
    throw invalidCCStream("upstream assistant role is invalid")
  if (delta.content !== undefined && delta.content !== null) {
    if (typeof delta.content !== "string")
      throw invalidCCStream("upstream content delta is invalid")
    if (streamState.messageOutputIndex === undefined)
      streamState.messageOutputIndex = allocateOutput(streamState, {
        kind: "message",
      })
    streamState.accumulatedText += delta.content
  }
}

function captureCCReasoning(
  delta: Record<string, unknown>,
  streamState: CCToResponsesStreamState,
): void {
  const reasoning = delta.reasoning_content ?? delta.reasoning_text
  if (reasoning !== undefined && reasoning !== null) {
    if (typeof reasoning !== "string")
      throw invalidCCStream("upstream reasoning delta is invalid")
    if (streamState.reasoningOutputIndex === undefined)
      streamState.reasoningOutputIndex = allocateOutput(streamState, {
        kind: "reasoning",
      })
    streamState.accumulatedReasoningText += reasoning
  }
}

function captureCCRefusal(
  delta: Record<string, unknown>,
  streamState: CCToResponsesStreamState,
): void {
  if (delta.refusal !== undefined && delta.refusal !== null) {
    if (typeof delta.refusal !== "string")
      throw invalidCCStream("upstream refusal delta is invalid")
    streamState.sawRefusal = true
    if (streamState.messageOutputIndex === undefined)
      streamState.messageOutputIndex = allocateOutput(streamState, {
        kind: "message",
      })
    streamState.accumulatedRefusal += delta.refusal
  }
}

function captureCCFinishReason(
  value: unknown,
  streamState: CCToResponsesStreamState,
): void {
  if (value === undefined || value === null) return
  if (
    value !== "stop"
    && value !== "length"
    && value !== "tool_calls"
    && value !== "content_filter"
  )
    throw invalidCCStream("upstream finish reason is invalid")
  streamState.finishReason = value
}

function captureCCChoice(
  choice: unknown,
  streamState: CCToResponsesStreamState,
): void {
  if (!isRecord(choice)) throw invalidCCStream("upstream choice is invalid")
  if (choice.index !== 0)
    throw invalidCCStream("upstream choice index is unsupported")
  if (!isRecord(choice.delta))
    throw invalidCCStream("upstream choice delta is invalid")
  if (streamState.finishReason)
    throw invalidCCStream("upstream sent data after the terminal choice")
  const delta = choice.delta
  captureCCText(delta, streamState)
  captureCCReasoning(delta, streamState)
  captureCCRefusal(delta, streamState)
  captureCCToolCalls(delta.tool_calls, streamState)
  captureCCFinishReason(choice.finish_reason, streamState)
}

export function translateFromCCStreamToResponsesEvents(
  chunk: Record<string, unknown>,
  streamState: CCToResponsesStreamState,
): Array<ResponsesSSEEvent> {
  if (streamState.terminalEmitted)
    throw invalidCCStream("upstream sent data after response terminal")
  if (chunk.error !== undefined && chunk.error !== null) {
    throw new HTTPError(
      "Upstream chat completion stream failed",
      Response.json({ error: chunk.error }, { status: 502 }),
    )
  }
  captureCCIdentity(chunk, streamState)
  captureCCUsage(chunk.usage, streamState)
  if (!Array.isArray(chunk.choices))
    throw invalidCCStream("upstream choices are invalid")
  if (chunk.choices.length === 0) return []
  if (chunk.choices.length !== 1)
    throw invalidCCStream("upstream returned multiple choices")
  captureCCChoice(chunk.choices[0], streamState)
  return []
}

function resolveCCId(fragments: Array<string>): string | undefined {
  const values = fragments.filter(Boolean)
  if (values.length === 0) return undefined
  const id = values[0]
  if (values.some((value) => value !== id))
    throw invalidCCStream("upstream tool-call identity changed")
  return id
}

function reachableNamePositions(
  fragments: Array<string>,
  candidate: string,
): ReadonlySet<number> {
  let positions = new Set([0])
  for (const fragment of fragments) {
    const next = new Set<number>()
    for (const position of positions) {
      if (candidate.startsWith(fragment, position))
        next.add(position + fragment.length)
      if (fragment.length >= position && candidate.startsWith(fragment))
        next.add(fragment.length)
    }
    positions = next
    if (positions.size === 0) break
  }
  return positions
}

function resolveCCName(
  fragments: Array<string>,
  allowed: ReadonlySet<string>,
): string | undefined {
  const values = fragments.filter(Boolean)
  if (values.length === 0) return undefined
  const reachable = [...allowed].map((candidate) => ({
    candidate,
    positions: reachableNamePositions(values, candidate),
  }))
  const complete = reachable.filter(({ candidate, positions }) =>
    positions.has(candidate.length),
  )
  if (complete.length === 1) return complete[0].candidate
  if (complete.length > 1)
    throw invalidCCStream("upstream tool name is ambiguous")
  if (reachable.some(({ positions }) => positions.size > 0)) return undefined
  throw invalidCCStream("upstream tool name changed")
}

function argumentJsonClass(
  call: PendingCCToolCall,
): "absent" | "empty" | "whitespace" | "malformed" | "object" | "non_object" {
  if (!call.sawArguments) return "absent"
  if (call.arguments === "") return "empty"
  if (call.arguments.trim() === "") return "whitespace"
  try {
    const parsed: unknown = JSON.parse(call.arguments)
    return isRecord(parsed) ? "object" : "non_object"
  } catch {
    return "malformed"
  }
}

function argumentPresence(
  call: PendingCCToolCall,
): "absent" | "empty" | "nonempty" {
  if (!call.sawArguments) return "absent"
  return call.arguments === "" ? "empty" : "nonempty"
}

function toolFailureMetadata(options: {
  call: PendingCCToolCall
  contract: CCToolContract | undefined
  idPresent: boolean
  nameResolved: boolean
  streamState: CCToResponsesStreamState
}): Record<string, unknown> {
  const { call, contract, idPresent, nameResolved, streamState } = options
  return {
    finishReason: streamState.finishReason,
    argumentPresence: argumentPresence(call),
    argumentJsonClass: argumentJsonClass(call),
    argumentByteCount: new TextEncoder().encode(call.arguments).byteLength,
    idPresent,
    nameResolved,
    schemaNoInput: contract?.noInput ?? false,
  }
}

function resolveCompletedTools(
  streamState: CCToResponsesStreamState,
): Map<number, CompletedCCToolCall> {
  const completed = new Map<number, CompletedCCToolCall>()
  const usedIds = new Set<string>()
  const allowedNames = new Set(streamState.toolContracts.keys())
  for (const [index, call] of streamState.pendingToolCalls) {
    const id = resolveCCId(call.idFragments)
    const name = resolveCCName(call.nameFragments, allowedNames)
    const contract = name ? streamState.toolContracts.get(name) : undefined
    if (!id || !name || !contract) {
      consola.warn(
        "[responses→cc] rejected completed tool call",
        toolFailureMetadata({
          streamState,
          call,
          contract,
          idPresent: Boolean(id),
          nameResolved: Boolean(name),
        }),
      )
      throw invalidCCStream("completed tool call lacks a declared identity")
    }
    if (usedIds.has(id))
      throw invalidCCStream("completed tool calls reuse an identity")
    usedIds.add(id)
    let args = call.arguments
    if (contract.noInput && (!call.sawArguments || call.arguments === "")) {
      consola.warn("[responses→cc] normalized omitted tool arguments", {
        reason: "completed_declared_no_input",
        argumentPresence: argumentPresence(call),
        argumentJsonClass: argumentJsonClass(call),
        argumentByteCount: 0,
        idPresent: true,
        nameResolved: true,
        schemaNoInput: true,
      })
      args = "{}"
    }
    try {
      parseToolInput(args, name, contract.schema)
    } catch (error) {
      consola.warn(
        "[responses→cc] rejected completed tool call",
        toolFailureMetadata({
          streamState,
          call,
          contract,
          idPresent: true,
          nameResolved: true,
        }),
      )
      throw error
    }
    completed.set(index, {
      outputIndex: call.outputIndex,
      id,
      name,
      arguments: args,
    })
  }
  return completed
}

function messageItem(
  streamState: CCToResponsesStreamState,
  status: "completed" | "incomplete",
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = []
  if (streamState.accumulatedText !== "")
    content.push({ type: "output_text", text: streamState.accumulatedText })
  if (streamState.sawRefusal)
    content.push({ type: "refusal", refusal: streamState.accumulatedRefusal })
  return {
    id: `${streamState.responseId}_message`,
    type: "message",
    status,
    role: "assistant",
    content,
  }
}

function reasoningItem(
  streamState: CCToResponsesStreamState,
  status: "completed" | "incomplete",
): Record<string, unknown> {
  return {
    id: `${streamState.responseId}_reasoning`,
    type: "reasoning",
    status,
    summary: [
      { type: "summary_text", text: streamState.accumulatedReasoningText },
    ],
  }
}

function emitMessageEvents(options: {
  out: Array<ResponsesSSEEvent>
  outputIndex: number
  status: "completed" | "incomplete"
  streamState: CCToResponsesStreamState
}): Record<string, unknown> {
  const { out, outputIndex, status, streamState } = options
  const item = messageItem(streamState, status)
  const itemId = item.id as string
  out.push(
    nextEvent(streamState, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: streamState.responseId,
      output_index: outputIndex,
      item: { ...item, status: "in_progress", content: [] },
    }),
  )
  let contentIndex = 0
  for (const part of item.content as Array<Record<string, unknown>>) {
    const isRefusal = part.type === "refusal"
    const text = (isRefusal ? part.refusal : part.text) as string
    const prefix = isRefusal ? "response.refusal" : "response.output_text"
    out.push(
      nextEvent(streamState, "response.content_part.added", {
        type: "response.content_part.added",
        response_id: streamState.responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part:
          isRefusal ?
            { type: "refusal", refusal: "" }
          : { type: "output_text", text: "" },
      }),
      nextEvent(streamState, `${prefix}.delta`, {
        type: `${prefix}.delta`,
        response_id: streamState.responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        delta: text,
      }),
      nextEvent(streamState, `${prefix}.done`, {
        type: `${prefix}.done`,
        response_id: streamState.responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        [isRefusal ? "refusal" : "text"]: text,
      }),
      nextEvent(streamState, "response.content_part.done", {
        type: "response.content_part.done",
        response_id: streamState.responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part,
      }),
    )
    contentIndex += 1
  }
  out.push(
    nextEvent(streamState, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: streamState.responseId,
      output_index: outputIndex,
      item,
    }),
  )
  return item
}

function emitReasoningEvents(options: {
  out: Array<ResponsesSSEEvent>
  outputIndex: number
  status: "completed" | "incomplete"
  streamState: CCToResponsesStreamState
}): Record<string, unknown> {
  const { out, outputIndex, status, streamState } = options
  const item = reasoningItem(streamState, status)
  const itemId = item.id as string
  const text = streamState.accumulatedReasoningText
  out.push(
    nextEvent(streamState, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: streamState.responseId,
      output_index: outputIndex,
      item: { ...item, status: "in_progress", summary: [] },
    }),
    nextEvent(streamState, "response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      response_id: streamState.responseId,
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
    nextEvent(streamState, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      response_id: streamState.responseId,
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      delta: text,
    }),
    nextEvent(streamState, "response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      response_id: streamState.responseId,
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      text,
    }),
    nextEvent(streamState, "response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      response_id: streamState.responseId,
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text },
    }),
    nextEvent(streamState, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: streamState.responseId,
      output_index: outputIndex,
      item,
    }),
  )
  return item
}

function emitCompletedToolEvents(
  streamState: CCToResponsesStreamState,
  tool: CompletedCCToolCall,
  out: Array<ResponsesSSEEvent>,
): Record<string, unknown> {
  const item = {
    id: tool.id,
    type: "function_call",
    status: "completed",
    call_id: tool.id,
    name: tool.name,
    arguments: tool.arguments,
  }
  out.push(
    nextEvent(streamState, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: streamState.responseId,
      output_index: tool.outputIndex,
      item: { ...item, status: "in_progress", arguments: "" },
    }),
    nextEvent(streamState, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      response_id: streamState.responseId,
      item_id: tool.id,
      output_index: tool.outputIndex,
      delta: tool.arguments,
    }),
    nextEvent(streamState, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: streamState.responseId,
      item_id: tool.id,
      output_index: tool.outputIndex,
      call_id: tool.id,
      name: tool.name,
      arguments: tool.arguments,
    }),
    nextEvent(streamState, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: streamState.responseId,
      output_index: tool.outputIndex,
      item,
    }),
  )
  return item
}

function partialToolItem(
  index: number,
  streamState: CCToResponsesStreamState,
): Record<string, unknown> | undefined {
  const call = streamState.pendingToolCalls.get(index)
  if (!call) return undefined
  const id = resolveCCId(call.idFragments)
  const name = resolveCCName(
    call.nameFragments,
    new Set(streamState.toolContracts.keys()),
  )
  if (!id || !name) return undefined
  return {
    id,
    type: "function_call",
    status: "incomplete",
    call_id: id,
    name,
    arguments: call.arguments,
  }
}

function emitPartialToolEvents(options: {
  item: Record<string, unknown>
  out: Array<ResponsesSSEEvent>
  outputIndex: number
  streamState: CCToResponsesStreamState
}): void {
  const { item, out, outputIndex, streamState } = options
  out.push(
    nextEvent(streamState, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: streamState.responseId,
      output_index: outputIndex,
      item: { ...item, status: "in_progress", arguments: "" },
    }),
  )
  if (item.arguments !== "")
    out.push(
      nextEvent(streamState, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        response_id: streamState.responseId,
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      }),
    )
}

function validateCCFinish(
  finishReason: CCToResponsesStreamState["finishReason"],
  completedTools: Map<number, CompletedCCToolCall>,
  interrupted: boolean,
): void {
  if (
    !interrupted
    && ((finishReason === "tool_calls" && completedTools.size === 0)
      || (finishReason === "stop" && completedTools.size > 0))
  )
    throw invalidCCStream("finish reason conflicts with tool-call output")
}

function emitBufferedCCOutput(options: {
  completedTools: Map<number, CompletedCCToolCall>
  filtered: boolean
  incomplete: boolean
  refused: boolean
  status: "completed" | "incomplete"
  streamState: CCToResponsesStreamState
}): {
  events: Array<ResponsesSSEEvent>
  output: Array<Record<string, unknown>>
} {
  const { completedTools, filtered, incomplete, refused, status, streamState } =
    options
  const events: Array<ResponsesSSEEvent> = []
  const output: Array<Record<string, unknown>> = []
  let finalOutputIndex = 0
  for (const slot of streamState.outputOrder) {
    if (slot.kind === "message") {
      output.push(
        emitMessageEvents({
          streamState,
          outputIndex: finalOutputIndex++,
          status,
          out: events,
        }),
      )
      continue
    }
    if (slot.kind === "reasoning") {
      output.push(
        emitReasoningEvents({
          streamState,
          outputIndex: finalOutputIndex++,
          status,
          out: events,
        }),
      )
      continue
    }
    if (refused || filtered) continue
    if (incomplete) {
      const partial = partialToolItem(slot.toolIndex, streamState)
      if (partial) {
        emitPartialToolEvents({
          streamState,
          outputIndex: finalOutputIndex++,
          item: partial,
          out: events,
        })
        output.push(partial)
      }
      continue
    }
    const tool = completedTools.get(slot.toolIndex)
    if (!tool) throw invalidCCStream("completed tool call was lost")
    output.push(
      emitCompletedToolEvents(
        streamState,
        { ...tool, outputIndex: finalOutputIndex++ },
        events,
      ),
    )
  }
  return { events, output }
}

export function finalizeCCToResponsesStream(
  streamState: CCToResponsesStreamState,
): Array<ResponsesSSEEvent> {
  if (streamState.terminalEmitted)
    throw invalidCCStream("upstream response terminal was repeated")
  const finishReason = streamState.finishReason
  if (!finishReason)
    throw invalidCCStream("upstream stream ended without a finish reason")
  const refused = streamState.sawRefusal
  const incomplete = finishReason === "length" && !refused
  const filtered = finishReason === "content_filter" && !refused
  const completedTools =
    !incomplete && !filtered && !refused ?
      resolveCompletedTools(streamState)
    : new Map<number, CompletedCCToolCall>()
  validateCCFinish(
    finishReason,
    completedTools,
    refused || incomplete || filtered,
  )
  const status = incomplete || filtered ? "incomplete" : "completed"
  const { events, output } = emitBufferedCCOutput({
    completedTools,
    filtered,
    incomplete,
    refused,
    status,
    streamState,
  })
  const terminalType =
    status === "incomplete" ? "response.incomplete" : "response.completed"
  events.push(
    nextEvent(streamState, terminalType, {
      type: terminalType,
      response: responseSnapshot({
        streamState,
        status,
        output,
        incompleteReason: filtered ? "content_filter" : "max_output_tokens",
      }),
    }),
  )
  streamState.terminalEmitted = true
  return events
}

export function ccToResponsesFailureMetadata(error: unknown): {
  kind: "protocol" | "transport" | "upstream_http" | "unexpected"
  reason:
    | "abort"
    | "failure"
    | "invalid_output"
    | "size_limit"
    | "timeout"
    | "upstream_error"
  status: number | null
} {
  if (error instanceof HTTPError) {
    return {
      kind:
        error.message.startsWith("Invalid upstream tool call") ?
          "protocol"
        : "upstream_http",
      reason:
        error.message.startsWith("Invalid upstream tool call") ?
          "invalid_output"
        : "upstream_error",
      status: error.response.status,
    }
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError")
      return { kind: "transport", reason: "timeout", status: null }
    if (error.name === "AbortError")
      return { kind: "transport", reason: "abort", status: null }
    if (error.name === "UpstreamEventStreamLimitError")
      return { kind: "transport", reason: "size_limit", status: null }
    return { kind: "transport", reason: "failure", status: null }
  }
  return { kind: "unexpected", reason: "failure", status: null }
}

async function ccFailureDetails(
  error: unknown,
): Promise<{ code: string; message: string }> {
  if (error instanceof HTTPError) {
    let body: unknown
    let fallback = error.message
    try {
      fallback = await error.response.clone().text()
      body = JSON.parse(fallback) as unknown
    } catch {
      body = null
    }
    const message = extractUpstreamErrorMessage(
      body,
      fallback,
      error.response.headers.get("content-type"),
    )
    const details =
      isRecord(body) && isRecord(body.error) ? body.error : undefined
    let code = "upstream_error"
    if (typeof details?.code === "string") code = details.code
    else if (error.message.startsWith("Invalid upstream tool call"))
      code = "invalid_tool_call"
    return { code, message }
  }
  const message = error instanceof Error ? error.message : ""
  if (isContextWindowError(message))
    return { code: "context_length_exceeded", message }
  return {
    code: "stream_error",
    message: "The upstream Chat completion stream failed before completion.",
  }
}

export async function createCCToResponsesFailedEvent(
  streamState: CCToResponsesStreamState,
  error: unknown,
): Promise<ResponsesSSEEvent> {
  if (streamState.terminalEmitted)
    throw invalidCCStream("upstream response terminal was repeated")
  streamState.terminalEmitted = true
  const details = await ccFailureDetails(error)
  return nextEvent(streamState, "response.failed", {
    type: "response.failed",
    response: {
      id: streamState.responseId,
      object: "response",
      model: streamState.model,
      status: "failed",
      output: [],
      error: details,
      usage: streamState.usage,
      metadata: {},
    },
  })
}

function validateBufferedResponse(resp: ResponsesResponse): void {
  if (!resp.status) {
    throw invalidToolInput(
      "response",
      "buffered output lacks an explicit completion status",
    )
  }
  if (
    resp.output.some(
      (item) =>
        !["function_call", "message", "reasoning"].includes(item.type)
        || (item.type === "message"
          && item.content.some(
            (part) => !["output_text", "refusal"].includes(part.type),
          )),
    )
  ) {
    throw invalidToolInput(
      "response",
      "unexpected server action in buffered output",
    )
  }
}

// eslint-disable-next-line complexity
export function translateFromResponsesResponse(
  resp: ResponsesResponse,
  strictOutput = false,
): ChatCompletionResponse {
  if (resp.error !== undefined && resp.error !== null) {
    throwResponseError({
      type: `response.${resp.status ?? "failed"}`,
      response: { ...resp },
    })
  }
  const outputTruncated =
    resp.status === "incomplete"
    && resp.incomplete_details?.reason === "max_output_tokens"
  if (resp.status && resp.status !== "completed" && !outputTruncated) {
    throwResponseError({
      type: `response.${resp.status}`,
      response: { ...resp },
    })
  }
  if (strictOutput) validateBufferedResponse(resp)
  const refused = hasResponseRefusal(resp)
  let textContent: string | null = null
  const toolCalls: Array<ToolCall> = []

  for (const item of resp.output) {
    if (item.type === "message") {
      const texts = item.content
        .filter(
          (c) =>
            (c.type === "output_text" && c.text !== undefined && c.text !== "")
            || (refused && c.type === "refusal"),
        )
        .map((c) => c.refusal ?? c.text ?? "")
      if (texts.length > 0) {
        textContent = texts.join("\n\n")
      }
    } else if (item.type === "function_call" && !refused) {
      if (!outputTruncated) parseToolInput(item.arguments, item.name)
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

  const finishReason = responseFinishReason(
    refused,
    outputTruncated,
    toolCalls.length > 0,
  )

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
          ...(refused ? { refusal: textContent } : {}),
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
      ...(resp.usage.input_tokens_details && {
        prompt_tokens_details: resp.usage.input_tokens_details,
      }),
    },
  }
}

function hasResponseRefusal(resp: ResponsesResponse): boolean {
  return resp.output.some(
    (item) =>
      item.type === "message"
      && item.content.some((part) => part.type === "refusal"),
  )
}

function responseFinishReason(
  refused: boolean,
  outputTruncated: boolean,
  hasToolCalls: boolean,
): "content_filter" | "length" | "tool_calls" | "stop" {
  if (refused) return "content_filter"
  if (outputTruncated) return "length"
  return hasToolCalls ? "tool_calls" : "stop"
}

// ─── Stream translation: Responses API SSE event → Chat Completion SSE chunk ─

/**
 * Mutable state shared across a single streaming response so that
 * `response.output_item.added` can hand off the tool-call identity
 * (call_id + name) to the subsequent `function_call_arguments.delta` chunks.
 *
 * Prefer stable output_index, validate matching item identities, and allow
 * opaque item IDs only when no indexed owner exists and one call is pending.
 * Tool arguments remain buffered until response.completed.
 */
export interface ResponsesStreamState {
  toolCalls: Array<{
    call_id: string
    name: string
    item_id?: string
    output_index?: number
    arguments: string
    done: boolean
  }>
  /** Whether any tool calls were seen during this response (for finish_reason). */
  hasToolCalls: boolean
  /** Whether any text content was seen during this response. */
  hasTextContent: boolean
  /** Usage data extracted from response.completed event. */
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export function createResponsesStreamState(): ResponsesStreamState {
  return {
    toolCalls: [],
    hasToolCalls: false,
    hasTextContent: false,
  }
}

export interface TranslateStreamOptions {
  responseId: string
  model: string
  streamState: ResponsesStreamState
}

// eslint-disable-next-line complexity -- Dispatch distinct wire event types without merging identity or terminal semantics.
export function translateFromResponsesStream(
  event: Record<string, unknown>,
  options: TranslateStreamOptions,
): SSEMessage | Array<SSEMessage> | null {
  const { responseId, model, streamState } = options
  const type = event.type as string
  if (type === "error" || type === "response.failed") throwResponseError(event)

  if (type === "response.incomplete") {
    if (!isMaxOutputTokensIncomplete(event.response)) throwResponseError(event)
    const response = event.response as Record<string, unknown>
    const refusal = responseRefusalText(response.output)
    if (refusal !== undefined) {
      return handleResponsesRefusal(response, {
        responseId,
        model,
        streamState,
        refusal,
      })
    }
    if (Array.isArray(response.output)) {
      for (const [index, item] of response.output.entries()) {
        handleOutputItemAdded(
          { type: "response.output_item.done", output_index: index, item },
          streamState,
        )
      }
    }
    return handleResponseCompleted(event, {
      responseId,
      model,
      streamState,
      finishReason: "length",
    })
  }

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

  if (
    type === "response.output_item.added"
    || type === "response.output_item.done"
  ) {
    return handleOutputItemAdded(event, streamState)
  }

  if (type === "response.function_call_arguments.delta") {
    const call = findResponseToolCall(event, streamState)
    if (typeof event.delta !== "string")
      throw invalidToolInput(call.name, "invalid argument delta")
    call.arguments += event.delta
    return null
  }

  if (type === "response.function_call_arguments.done") {
    // Complete this identity independently; other calls may still be pending.
    const call = findResponseToolCall(event, streamState)
    reconcileArguments(call, event.arguments)
    call.done = true
    return null
  }

  if (type === "response.completed") {
    const response = event.response as Record<string, unknown> | undefined
    if (Array.isArray(response?.output)) {
      for (const [index, item] of response.output.entries()) {
        handleOutputItemAdded(
          { type: "response.output_item.done", output_index: index, item },
          streamState,
        )
      }
    }
    return handleResponseCompleted(event, {
      responseId,
      model,
      streamState,
    })
  }

  return null
}

function throwResponseError(event: Record<string, unknown>): never {
  const response = event.response
  const details =
    response && typeof response === "object" && !Array.isArray(response) ?
      (response as Record<string, unknown>)
    : event
  const body =
    details.error ?
      { status: details.status, error: details.error }
    : { error: details }
  const message = extractUpstreamErrorMessage(
    body,
    "Upstream response did not complete.",
    "application/json",
  )
  throw new HTTPError(message, Response.json(body, { status: 502 }))
}

function isMaxOutputTokensIncomplete(response: unknown): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return false
  const record = response as Record<string, unknown>
  if (
    record.status !== "incomplete"
    || (record.error !== undefined && record.error !== null)
  ) {
    return false
  }
  const details = record.incomplete_details
  return (
    details !== null
    && typeof details === "object"
    && !Array.isArray(details)
    && (details as Record<string, unknown>).reason === "max_output_tokens"
  )
}

function responseRefusalText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (record.type !== "message" || !Array.isArray(record.content)) continue
    for (const part of record.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue
      const content = part as Record<string, unknown>
      if (content.type === "refusal" && typeof content.refusal === "string")
        return content.refusal
    }
  }
  return undefined
}

function handleResponsesRefusal(
  response: Record<string, unknown>,
  options: Pick<
    TranslateStreamOptions,
    "responseId" | "model" | "streamState"
  > & { refusal: string },
): Array<SSEMessage> {
  const { responseId, model, streamState, refusal } = options
  const usage = response.usage as Record<string, number> | undefined
  const chunks: Array<SSEMessage> = []
  if (refusal) chunks.push(makeTextDeltaChunk(responseId, model, refusal))
  chunks.push(
    makeFinishChunk({
      id: responseId,
      model,
      finishReason: "content_filter",
    }),
  )
  if (usage) {
    chunks.push(
      makeChunk(responseId, model, {
        choices: [],
        usage: {
          prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
          completion_tokens:
            usage.output_tokens || usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0,
        },
      }),
    )
  }
  streamState.hasToolCalls = false
  return chunks
}

function handleResponseCompleted(
  event: Record<string, unknown>,
  options: Pick<
    TranslateStreamOptions,
    "responseId" | "model" | "streamState"
  > & { finishReason?: "length" },
): Array<SSEMessage> {
  const { responseId, model, streamState, finishReason } = options
  const resp = event.response as Record<string, unknown> | undefined
  const usage = resp?.usage as Record<string, number> | undefined
  if (usage) {
    streamState.usage = {
      prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    }
  }

  const chunks: Array<SSEMessage> = []

  for (const [index, call] of streamState.toolCalls.entries()) {
    if (finishReason !== "length") parseToolInput(call.arguments, call.name)
    chunks.push(
      makeToolCallChunk(responseId, model, {
        index,
        args: call.arguments,
        identity: { id: call.call_id, name: call.name, type: "function" },
      }),
    )
  }

  chunks.push(
    makeFinishChunk({
      id: responseId,
      model,
      finishReason:
        finishReason ?? (streamState.hasToolCalls ? "tool_calls" : "stop"),
    }),
  )

  if (streamState.usage) {
    chunks.push(
      makeChunk(responseId, model, {
        choices: [],
        usage: streamState.usage,
      }),
    )
  }

  return chunks
}

/** Stash tool-call identity so argument deltas can reference it later. */
function handleOutputItemAdded(
  event: Record<string, unknown>,
  streamState: ResponsesStreamState,
): null {
  const item = event.item as Record<string, unknown> | undefined
  if (item && typeof item.call_id === "string") {
    if (typeof item.name !== "string" || !item.name)
      throw invalidToolInput("unknown", "missing function name")
    let call = streamState.toolCalls.find(
      (candidate) => candidate.call_id === item.call_id,
    )
    if (!call) {
      call = {
        call_id: item.call_id,
        name: item.name,
        arguments: "",
        done: false,
        item_id: typeof item.id === "string" ? item.id : undefined,
        output_index:
          typeof event.output_index === "number" ?
            event.output_index
          : undefined,
      }
      streamState.toolCalls.push(call)
    }
    if (typeof item.arguments === "string" && item.arguments) {
      reconcileArguments(call, item.arguments)
    }
    if (event.type === "response.output_item.done") call.done = true
    streamState.hasToolCalls = true
  }
  return null
}

/** Translate a function_call_arguments.delta event into a Chat Completion chunk. */
function findResponseToolCall(
  event: Record<string, unknown>,
  state: ResponsesStreamState,
): ResponsesStreamState["toolCalls"][number] {
  const byId =
    typeof event.item_id === "string" ?
      state.toolCalls.find((call) => call.item_id === event.item_id)
    : undefined
  if (typeof event.output_index === "number") {
    const byIndex = state.toolCalls.find(
      (call) => call.output_index === event.output_index,
    )
    if (byIndex) {
      if (byId && byId !== byIndex)
        throw invalidToolInput(
          byIndex.name,
          "conflicting streamed function identities",
        )
      return byIndex
    }
    // Older Copilot frames omit indices when introducing the call; attach a
    // later index only to the single unindexed candidate, never another index.
    const unindexed = state.toolCalls.filter(
      (call) => !call.done && call.output_index === undefined,
    )
    if (unindexed.length !== 1 || (byId && byId !== unindexed[0])) {
      throw invalidToolInput("unknown", "unknown indexed function identity")
    }
    unindexed[0].output_index = event.output_index
    return unindexed[0]
  }
  if (byId) return byId
  // Some Copilot streams use opaque, nonmatching item IDs. Only a single
  // unfinished call is unambiguous; never guess a FIFO owner for parallel calls.
  const pending = state.toolCalls.filter((call) => !call.done)
  if (pending.length !== 1)
    throw invalidToolInput(
      "unknown",
      "ambiguous or missing streamed function identity",
    )
  return pending[0]
}

function reconcileArguments(
  call: ResponsesStreamState["toolCalls"][number],
  complete: unknown,
): void {
  if (typeof complete !== "string" || !complete.startsWith(call.arguments)) {
    throw invalidToolInput(
      call.name,
      "inconsistent complete arguments and streamed deltas",
    )
  }
  call.arguments = complete
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

function makeFinishChunk(opts: {
  id: string
  model: string
  finishReason: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}): SSEMessage {
  return makeChunk(opts.id, opts.model, {
    choices: [
      { index: 0, delta: {}, finish_reason: opts.finishReason, logprobs: null },
    ],
    ...(opts.usage && { usage: opts.usage }),
  })
}

function makeToolCallChunk(
  id: string,
  model: string,
  toolCallData: {
    index: number
    args: string
    identity?: { id: string; type: string; name: string }
  },
): SSEMessage {
  const { index, args, identity } = toolCallData
  const toolCall: Record<string, unknown> = {
    index,
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
