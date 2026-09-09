import { repairOrphanedToolCalls } from "~/lib/tool-call-repair"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"
import { searchReplayText } from "~/services/web-search/replay"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicCustomTool,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicRedactedThinkingBlock,
  type AnthropicResponse,
  type AnthropicServerToolResultBlock,
  type AnthropicServerToolUseBlock,
  type AnthropicSystemBlock,
  type AnthropicSystemMessage,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
  isThinkingRequested,
} from "./anthropic-types"
import { clientTools } from "./client-tools"
import { parseToolInput, toolInputSchema } from "./tool-input"
import {
  createToolNameMapFromAnthropicPayload,
  toAnthropicToolIdentity,
  toOpenAIToolName,
  type ToolNameMap,
} from "./tool-name-mapping"
import {
  FILTERED_VISIBLE_OUTPUT_TEXT,
  mapOpenAIStopReasonToAnthropic,
  toAnthropicMessageId,
} from "./utils"

const MAX_TOOL_RESULT_CHARS = 20_000
const TOOL_RESULT_HEAD_CHARS = 5_000
const TOOL_RESULT_MIDDLE_CHARS = 3_000
const TOOL_RESULT_TAIL_CHARS = 5_000

/**
 * Type guard for server tool result blocks. Matches web_search_tool_result,
 * web_fetch_tool_result, code_execution_tool_result, etc.
 * Explicitly excludes plain "tool_result" (which has its own handler).
 */
function isServerToolResultBlock(
  block: AnthropicUserContentBlock | AnthropicAssistantContentBlock,
): block is AnthropicServerToolResultBlock {
  return block.type.endsWith("_tool_result") && block.type !== "tool_result"
}

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  toolNameMap: ToolNameMap = createToolNameMapFromAnthropicPayload(payload),
): ChatCompletionsPayload {
  const messages = translateAnthropicMessagesToOpenAI(
    payload.messages,
    payload.system,
    toolNameMap,
  )

  // When structured output is requested (e.g. title generation), reinforce
  // the JSON constraint directly in the messages.  The Copilot Chat
  // Completions API ignores the `response_format` parameter, so the model
  // only obeys the instruction if it appears prominently in the prompt.
  if (payload.output_config?.format) {
    enforceJsonOutput(messages)
  }

  const tools = translateAnthropicToolsToOpenAI(payload.tools, toolNameMap)

  // Copilot rejects the request outright ("tools are required when tool choice
  // is specified") when `tool_choice` is present without a non-empty `tools`
  // array.  This happens routinely with Claude Desktop / Cowork, which sends
  // `tool_choice: {type: "auto"}` alongside *only* server-side typed tools
  // (e.g. `web_search_20250305`).  Those typed tools are filtered out by
  // `translateAnthropicToolsToOpenAI`, leaving an orphaned `tool_choice` and a
  // hard 400 that kills the whole turn — including every web search.
  //
  // Suppress `tool_choice` whenever no callable tool survives translation.
  // `"none"` is also dropped: with no tools it is a no-op, and sending it
  // alongside an absent `tools` array trips the same upstream validation.
  const toolChoice =
    tools ?
      translateAnthropicToolChoiceToOpenAI(payload.tool_choice, toolNameMap)
    : undefined

  return {
    model: translateModelName(payload.model),
    messages,
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    // Request usage data in the final streaming chunk so Claude Code can
    // track actual input_tokens for proactive context-window compaction.
    // Without this, streaming chunks have no usage → input_tokens defaults
    // to 0 → Claude Code never knows the context is filling up.
    stream_options: payload.stream ? { include_usage: true } : undefined,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools,
    tool_choice: toolChoice,
    ...(payload.tool_choice?.disable_parallel_tool_use !== undefined ?
      { parallel_tool_calls: !payload.tool_choice.disable_parallel_tool_use }
    : {}),
    response_format: translateOutputConfig(
      payload.output_config,
      payload.model,
    ),
    ...buildReasoningFromThinking(
      payload.thinking,
      payload.output_config?.effort,
    ),
  }
}

/**
 * Maps an Anthropic `thinking` config onto the Responses-API `reasoning`
 * control. Setting `summary: "auto"` is what makes Copilot stream
 * `reasoning_summary_text.delta` events in real time during the model's
 * thinking phase; without it the model reasons silently and the thinking text
 * only surfaces (all at once) at the end of the turn.
 *
 * The `budget_tokens` hint is translated to a coarse effort level so the
 * upstream allocates a comparable amount of reasoning.
 */
/**
 * Maps an Anthropic `output_config.effort` level onto Copilot's reasoning
 * effort. Copilot's reasoning control only recognizes low/medium/high, so the
 * newer `xhigh`/`max` depths clamp to `high`.
 */
function mapEffortLevel(
  effort: NonNullable<AnthropicMessagesPayload["output_config"]>["effort"],
): string | undefined {
  switch (effort) {
    case "low": {
      return "low"
    }
    case "medium": {
      return "medium"
    }
    case "high":
    case "xhigh":
    case "max": {
      return "high"
    }
    default: {
      return undefined
    }
  }
}

function buildReasoningFromThinking(
  thinking: AnthropicMessagesPayload["thinking"],
  outputEffort?: NonNullable<
    AnthropicMessagesPayload["output_config"]
  >["effort"],
): { reasoning?: { effort: string; summary: string } } {
  if (!isThinkingRequested(thinking)) return {}

  // Adaptive thinking depth (Claude 4.6+) is controlled by
  // `output_config.effort`. When present it takes precedence; otherwise fall
  // back to the classic `budget_tokens` hint (extended thinking).
  const mappedEffort = mapEffortLevel(outputEffort)
  let effort = mappedEffort ?? "medium"
  if (!mappedEffort) {
    const budget = thinking.budget_tokens
    if (typeof budget === "number") {
      if (budget <= 8_000) effort = "low"
      else if (budget >= 24_000) effort = "high"
    }
  }

  return { reasoning: { effort, summary: "auto" } }
}

function translateModelName(model: string): string {
  // Normalize claude-{family}-4-{minor}[-extra] → claude-{family}-4
  // Only applies to generation 4+ where minor version numbers are subagent-build-specific.
  // eslint-disable-next-line regexp/no-super-linear-backtracking, regexp/optimal-quantifier-concatenation
  return model.replace(/^(claude-[a-z]+-4)-\d+.*$/, "$1")
}

/**
 * Translates Anthropic's `output_config.format` to OpenAI's `response_format`.
 *
 * Claude Code sends `output_config.format.type = "json_schema"` for structured
 * output requests like title generation.  The Copilot Chat Completions API does
 * not support `json_schema` structured outputs, so we downgrade to `json_object`
 * which instructs the model to produce valid JSON.  The system prompt already
 * describes the expected JSON shape, so this is sufficient.
 *
 * Exception — Claude models: Copilot's Claude backend does not merely ignore
 * `response_format`, it rejects the request with HTTP 422 Unprocessable Entity.
 * For Claude we therefore omit `response_format` entirely and rely solely on
 * the system-prompt JSON enforcement (`enforceJsonOutput`) plus the
 * free-text → JSON repair in the structured-output handler.
 */
function translateOutputConfig(
  outputConfig: AnthropicMessagesPayload["output_config"],
  model: string,
): ChatCompletionsPayload["response_format"] {
  if (!outputConfig?.format) return undefined
  // Copilot rejects response_format for Claude models (422). JSON is still
  // enforced via the system prompt, so dropping it here is safe.
  if (model.startsWith("claude")) return undefined
  return { type: "json_object" }
}

/**
 * Appends a JSON enforcement instruction to the system message when structured
 * output is requested.  The Copilot Chat Completions API does not support the
 * `response_format` parameter, so models ignore the JSON constraint unless it
 * is spelled out in the prompt itself.  Without this, title generation requests
 * (which use `output_config.format`) produce free-form text answers instead of
 * the expected `{"title": "..."}` JSON, causing Claude Code to fall back to
 * "Conversation continuation summary".
 */
function enforceJsonOutput(messages: Array<Message>): void {
  const enforcement =
    "\n\nIMPORTANT: You MUST respond with valid JSON only. "
    + "Do not include any text, explanation, or markdown outside the JSON object. "
    + "Your entire response must be a single JSON object."

  const systemMsg = messages.find((m) => m.role === "system")
  if (systemMsg && typeof systemMsg.content === "string") {
    systemMsg.content += enforcement
  } else {
    // No system message — add one
    messages.unshift({ role: "system", content: enforcement.trim() })
  }
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicSystemBlock> | undefined,
  toolNameMap: ToolNameMap,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  const otherMessages = anthropicMessages.flatMap((message) => {
    if (message.role === "user") return handleUserMessage(message)
    // Mid-conversation system instructions (Anthropic's third message role,
    // sent by the Claude app / Claude Code). Emit an OpenAI `system` message in
    // place — Copilot's Chat Completions backend accepts system messages at any
    // position, so the instruction keeps its placement and semantics.
    if (message.role === "system") return handleSystemMessage(message)
    return handleAssistantMessage(message, toolNameMap)
  })

  const combined = [...systemMessages, ...otherMessages]

  // Drop/patch tool messages whose tool_use was removed from history (context
  // compaction, interrupted or parallel tool calls).  Copilot re-validates the
  // Anthropic invariant for Claude models and rejects any tool_result that has
  // no corresponding tool_use in the previous message.  Run this BEFORE the
  // merge so any orphan converted to a user message is then coalesced with an
  // adjacent user turn (Copilot expects strictly alternating roles).
  repairOrphanedToolCalls(combined)

  const merged = mergeConsecutiveSameRoleMessages(combined)

  // Final invariant: the conversation must end with a user (or tool) turn.
  // A trailing assistant message is an "assistant prefill" — native Anthropic
  // allows it, but Copilot's Claude backend rejects it:
  //   "This model does not support assistant message prefill. The conversation
  //    must end with a user message."
  // Claude Code's multi-agent / workflow ("ultracode") mode emits such prefills
  // (e.g. priming a structured-output reply). Normalize by appending a minimal
  // user continuation so the request ends with a user turn, keeping the
  // assistant prefill intact as the prior turn.
  return ensureConversationEndsWithUser(merged)
}

/**
 * Appends a minimal user continuation when the translated conversation ends
 * with an assistant message that has no pending tool_calls (an "assistant
 * prefill"). Copilot's Claude backend requires the conversation to end with a
 * user message; native Anthropic permits the prefill, so the proxy bridges the
 * gap here. A trailing assistant message that *does* carry tool_calls is left
 * untouched — appending a user turn would orphan those calls.
 */
function ensureConversationEndsWithUser(
  messages: Array<Message>,
): Array<Message> {
  const last = messages.at(-1)
  const hasPendingToolCalls = (last?.tool_calls?.length ?? 0) > 0
  if (last?.role === "assistant" && !hasPendingToolCalls) {
    messages.push({ role: "user", content: "Please continue." })
  }
  return messages
}

/**
 * Merges consecutive messages with the same role into a single message.
 *
 * The Anthropic API allows consecutive user messages (e.g. after compaction,
 * Claude Code sends a summary user message followed by the actual task as
 * another user message). The OpenAI/Copilot API expects strictly alternating
 * user/assistant roles — consecutive same-role messages confuse the model,
 * causing it to echo the summary instead of acting on the task.
 */
function mergeConsecutiveSameRoleMessages(
  messages: Array<Message>,
): Array<Message> {
  if (messages.length <= 1) return messages

  let previous: Message = messages[0]
  const merged: Array<Message> = [previous]

  for (let i = 1; i < messages.length; i++) {
    const current = messages[i]

    // `tool` messages are always standalone — each maps 1:1 to a tool_call and
    // must keep its own tool_call_id; never coalesce them.
    if (current.role !== previous.role || current.role === "tool") {
      merged.push(current)
      previous = current
      continue
    }

    // Same role (user↔user or assistant↔assistant): collapse into `previous`,
    // merging text AND preserving tool_calls. Naively copying only `.content`
    // would drop an assistant's tool_calls and orphan its tool results —
    //   "messages with role 'tool' must be a response to a preceeding message
    //    with 'tool_calls'."
    const prevText = extractTextContent(previous.content)
    const currText = extractTextContent(current.content)
    const combinedText = [prevText, currText].filter(Boolean).join("\n\n")
    previous.content = combinedText.length > 0 ? combinedText : previous.content

    if (current.tool_calls && current.tool_calls.length > 0) {
      previous.tool_calls = [
        ...(previous.tool_calls ?? []),
        ...current.tool_calls,
      ]
    }
  }

  return merged
}

function extractTextContent(
  content: string | Array<ContentPart> | null,
): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}

function handleSystemPrompt(
  system: string | Array<AnthropicSystemBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system
      .filter((block): block is AnthropicTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
    return systemText ? [{ role: "system", content: systemText }] : []
  }
}

/**
 * Translates a `role: "system"` message (mid-conversation system instructions,
 * new in the 2025 Messages API and sent by the Claude app / Claude Code) into
 * an OpenAI `system` message. Text is extracted from string or block content
 * (including embedded `mid_conv_system` blocks); non-text blocks are serialized
 * via the shared block serializer so nothing is silently dropped.
 */
function handleSystemMessage(message: AnthropicSystemMessage): Array<Message> {
  const text =
    typeof message.content === "string" ?
      message.content
    : message.content
        .map((block) => serializeBlockToText(block))
        .filter((part): part is string => part !== null && part.length > 0)
        .join("\n\n")
  return text ? [{ role: "system", content: text }] : []
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []
  const deferredUserContents: Array<string | Array<ContentPart>> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const serverToolResultBlocks = message.content.filter((block) =>
      isServerToolResultBlock(block),
    )
    const otherBlocks = message.content.filter(
      (block) =>
        block.type !== "tool_result" && !isServerToolResultBlock(block),
      // document blocks remain here intentionally — mapContent handles them
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      const toolResult = translateToolResultForOpenAI(block.content)
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: toolResult.toolContent,
      })
      if (toolResult.followUpUserContent) {
        deferredUserContents.push(toolResult.followUpUserContent)
      }
    }

    const otherContent = otherBlocks.length > 0 ? mapContent(otherBlocks) : null

    const combinedDeferredUserContent = mergeMessageContents([
      ...deferredUserContents,
      otherContent,
    ])
    if (combinedDeferredUserContent) {
      // When a user message contains both tool results and additional text
      // (e.g. Claude Code's Skill tool returns tool_result + text blocks in
      // the same user message), avoid emitting a standalone "user" message
      // between the tool result and the next assistant message.  Gemini
      // returns empty responses when it sees user → assistant(+tool_calls)
      // inside a tool-calling loop — it expects tool → assistant only.
      // Appending the extra text to the last tool result is safe for all
      // models; the OpenAI tool message content field accepts any text.
      if (toolResultBlocks.length > 0 && deferredUserContents.length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by length > 0
        const lastToolMsg = newMessages.at(-1)!
        const existingContent =
          typeof lastToolMsg.content === "string" ?
            lastToolMsg.content
          : JSON.stringify(lastToolMsg.content)
        const extraText =
          typeof combinedDeferredUserContent === "string" ?
            combinedDeferredUserContent
          : JSON.stringify(combinedDeferredUserContent)
        lastToolMsg.content = existingContent + "\n\n" + extraText
      } else {
        newMessages.push({
          role: "user",
          content: combinedDeferredUserContent,
        })
      }
    }

    // Server tool result blocks → serialize as user message
    if (serverToolResultBlocks.length > 0) {
      const text = serverToolResultBlocks
        .map((b) => serializeBlockToText(b))
        .join("\n\n")
      newMessages.push({ role: "user", content: text })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
  toolNameMap: ToolNameMap,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )

  const serverToolUseBlocks = message.content.filter(
    (block): block is AnthropicServerToolUseBlock =>
      block.type === "server_tool_use",
  )

  const serverToolResultBlocks = message.content.filter((block) =>
    isServerToolResultBlock(block),
  )

  // Strip thinking + redacted_thinking — Copilot doesn't understand them and
  // they massively inflate the prompt token count (thinking blocks from Claude
  // Code's internal reasoning can be thousands of tokens each).
  const visibleBlocks = message.content.filter(
    (
      block,
    ): block is Exclude<
      typeof block,
      AnthropicRedactedThinkingBlock | AnthropicThinkingBlock
    > => block.type !== "redacted_thinking" && block.type !== "thinking",
  )

  // Combine text and server_tool_use blocks for Branch 1 (tool_calls path)
  // OpenAI doesn't have separate server_tool_use blocks
  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...serverToolUseBlocks.map(
      (b) => `[Server tool use: ${JSON.stringify(b)}]`,
    ),
    ...serverToolResultBlocks.map((b) => serializeBlockToText(b)),
  ]
    .filter(Boolean)
    .join("\n\n")

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toOpenAIToolName(
                toolUse.name,
                toolNameMap,
                toolUse.toolset_name,
              ),
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [
        {
          role: "assistant",
          content: mapContent(visibleBlocks),
        },
      ]
}

// Handles tool_result content which may be a string or array of content blocks
function mapToolResultContent(
  content: AnthropicToolResultBlock["content"],
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  // Every nested tool-result block is also handled by mapContent.
  return mapContent(content)
}

function translateToolResultForOpenAI(
  content: AnthropicToolResultBlock["content"],
): {
  toolContent: string | Array<ContentPart> | null
  followUpUserContent?: string | Array<ContentPart> | null
} {
  if (typeof content === "string") {
    return { toolContent: compressToolResultText(content) }
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    const mappedContent = mapToolResultContent(content)
    return {
      toolContent:
        typeof mappedContent === "string" ?
          compressToolResultText(mappedContent)
        : mappedContent,
    }
  }

  const textContent = content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")

  return {
    toolContent:
      textContent
      || "[Non-text tool result forwarded in the following user message.]",
    followUpUserContent: mapContent(content),
  }
}

function compressToolResultText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) {
    return text
  }

  const omittedChars =
    text.length
    - TOOL_RESULT_HEAD_CHARS
    - TOOL_RESULT_MIDDLE_CHARS
    - TOOL_RESULT_TAIL_CHARS
  const head = text.slice(0, TOOL_RESULT_HEAD_CHARS).trimEnd()
  const middleStart = Math.max(
    TOOL_RESULT_HEAD_CHARS,
    Math.floor((text.length - TOOL_RESULT_MIDDLE_CHARS) / 2),
  )
  const middle = text
    .slice(middleStart, middleStart + TOOL_RESULT_MIDDLE_CHARS)
    .trim()
  const tail = text.slice(-TOOL_RESULT_TAIL_CHARS).trimStart()
  const lineCount = text.split("\n").length

  return [
    `[Tool result condensed by proxy: kept the first ${TOOL_RESULT_HEAD_CHARS.toLocaleString()}, `
      + `middle ${TOOL_RESULT_MIDDLE_CHARS.toLocaleString()}, and last `
      + `${TOOL_RESULT_TAIL_CHARS.toLocaleString()} characters `
      + `out of ${text.length.toLocaleString()} total; omitted `
      + `${omittedChars.toLocaleString()} characters across ${lineCount.toLocaleString()} lines `
      + `to avoid prompt overflow while preserving the latest tool findings.]`,
    "[If you need to stay within context, compact older conversation state before discarding this fresh tool result. If more detail is required, ask for a focused rerun or narrower command output.]",
    "",
    "=== BEGIN TOOL RESULT HEAD ===",
    head,
    "=== END TOOL RESULT HEAD ===",
    "",
    "=== BEGIN TOOL RESULT MIDDLE SAMPLE ===",
    middle,
    "=== END TOOL RESULT MIDDLE SAMPLE ===",
    "",
    "=== BEGIN TOOL RESULT TAIL ===",
    tail,
    "=== END TOOL RESULT TAIL ===",
  ].join("\n")
}

function mergeMessageContents(
  contents: Array<string | Array<ContentPart> | null | undefined>,
): string | Array<ContentPart> | null {
  const filtered = contents.filter(
    (content): content is string | Array<ContentPart> =>
      content !== null
      && content !== undefined
      && (!(typeof content === "string") || content.length > 0),
  )

  if (filtered.length === 0) return null
  if (filtered.every((content) => typeof content === "string")) {
    return filtered.join("\n\n")
  }

  const merged: Array<ContentPart> = []
  for (const content of filtered) {
    if (typeof content === "string") {
      merged.push({ type: "text", text: content })
      continue
    }
    merged.push(...content)
  }
  return merged
}

/**
 * Serializes a content block to a plain-text representation.
 * Used by both paths of mapContent for non-image/non-text blocks.
 * Returns null for blocks that should be silently skipped.
 */
function serializeBlockToText(
  block: AnthropicUserContentBlock | AnthropicAssistantContentBlock,
): string | null {
  switch (block.type) {
    case "text": {
      return block.text
    }
    case "document": {
      return "[Document: PDF content not displayable]"
    }
    case "server_tool_use": {
      return `[Server tool use: ${JSON.stringify(block)}]`
    }
    case "web_search_tool_result": {
      return `[web_search_tool_result: ${searchReplayText(block.content)}]`
    }
    case "search_result": {
      return `[Search: ${block.title}]\nSource: ${block.source}\n${block.content}`
    }
    case "container_upload": {
      return `[Container upload: ${block.file_id}]`
    }
    case "mid_conv_system": {
      // Mid-conversation system instructions embedded in a user message.
      // Surface the plain text so the model still receives the updated
      // guidance rather than an opaque JSON dump.
      const inner = block.content
      return typeof inner === "string" ? inner : (
          inner.map((b) => b.text).join("\n\n")
        )
    }
    case "tool_reference": {
      // Claude Code's client-side ToolSearch returns this block inside a
      // tool_result. The OpenAI format has no equivalent content part, and all
      // deferred definitions are already forwarded in `tools`, so preserve the
      // discovery signal as text instead of silently dropping it.
      return `[Tool loaded: ${block.toolset_name ? `${block.toolset_name}.` : ""}${block.tool_name}]`
    }
    case "browser_state": {
      return `[Browser state: ${JSON.stringify(block.tabs)}]`
    }
    default: {
      // Catch-all: server tool results and future unknown types
      if (
        "content" in block
        && (block.type as string) !== "thinking"
        && (block.type as string) !== "redacted_thinking"
      ) {
        return `[${block.type}: ${JSON.stringify((block as { content: unknown }).content)}]`
      }
      return null
    }
  }
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .map((block) => serializeBlockToText(block))
      .filter(Boolean)
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    if (block.type === "image") {
      if (block.source.type === "url") {
        contentParts.push({
          type: "image_url",
          image_url: { url: block.source.url },
        })
      } else {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
      }
    } else {
      const text = serializeBlockToText(block)
      if (text) {
        contentParts.push({ type: "text", text })
      }
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
  toolNameMap: ToolNameMap,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }

  const customTools: Array<Tool> = clientTools(anthropicTools).map((tool) => ({
    type: "function",
    function: {
      name: toOpenAIToolName(tool.name, toolNameMap, tool.toolset_name),
      description: translateToolDescription(tool),
      parameters: toolInputSchema(tool),
      // Forward strict for Structured Outputs; strip all other extra fields
      // (cache_control, defer_loading, eager_input_streaming, allowed_callers).
      // input_examples are adapted into the description above because the
      // OpenAI function format has no equivalent field.
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  }))
  // Return undefined (not []) when all tools are typed — an empty tools array with an active
  // tool_choice would produce a malformed OpenAI request.
  return customTools.length > 0 ? customTools : undefined
}

const MAX_TOOL_INPUT_EXAMPLE_CHARS = 1000
const MAX_TOOL_INPUT_EXAMPLES = 2

/**
 * Preserves Anthropic input examples in the OpenAI function description.
 *
 * Copilot's Chat Completions tool format has no `input_examples` field. Simply
 * dropping it is especially harmful for Workflow: its three selector fields
 * are individually optional in JSON Schema and a custom runtime validator
 * enforces that one is present. Without examples or an explicit constraint,
 * the model can emit `{}`, which Claude Desktop rejects before execution.
 */
function translateToolDescription(
  tool: AnthropicCustomTool,
): string | undefined {
  const sections: Array<string> = []
  if (tool.description) sections.push(tool.description)

  const examples = (tool.input_examples ?? [])
    .map((example) => JSON.stringify(example))
    .filter((example) => example.length <= MAX_TOOL_INPUT_EXAMPLE_CHARS)
    .slice(0, MAX_TOOL_INPUT_EXAMPLES)
  if (examples.length > 0) {
    sections.push(`Valid input examples:\n${examples.join("\n")}`)
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
  toolNameMap: ToolNameMap,
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: {
            name: toOpenAIToolName(anthropicToolChoice.name, toolNameMap),
          },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
  toolNameMap?: ToolNameMap,
): AnthropicResponse {
  // Merge content from all choices
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
    null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Process all choices to extract text and tool use blocks
  for (const choice of response.choices) {
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(
      choice.finish_reason === "content_filter" ?
        undefined
      : choice.message.tool_calls,
      toolNameMap,
    )

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  // Note: GitHub Copilot doesn't generate thinking blocks, so we don't include them in responses

  // Some models (notably Gemini) intermittently return a non-tool_calls
  // finish_reason ("stop", or even null — a degenerate shape) even when they
  // emitted tool calls. Correct this to "tool_calls" whenever tool-use blocks
  // are present, so Claude Code executes the pending tool calls instead of
  // treating the turn as done.
  //
  // The one exception is "length": a length-truncated turn with tool calls is
  // handled specially below (the arguments may be incomplete), so preserve it
  // here rather than masking it as "tool_calls".
  const correctedStopReason =
    (
      allToolUseBlocks.length > 0
      && stopReason !== "length"
      && stopReason !== "content_filter"
    ) ?
      "tool_calls"
    : stopReason

  if (correctedStopReason === "content_filter") {
    const visibleTextBlocks = allTextBlocks.filter(
      (block) => block.text.trim().length > 0,
    )
    return {
      id: toAnthropicMessageId(response.id),
      type: "message",
      role: "assistant",
      model: response.model,
      content:
        visibleTextBlocks.length > 0 ?
          visibleTextBlocks
        : [{ type: "text", text: FILTERED_VISIBLE_OUTPUT_TEXT }],
      stop_reason: "refusal",
      stop_sequence: null,
      usage: buildAnthropicUsage(response.usage),
    }
  }

  // Backstop: a completed non-streaming message must never carry
  // stop_reason: null. Anthropic clients (Claude Code, strict SDK callers)
  // treat null stop_reason on a non-stream response as a protocol violation.
  // Degenerate upstream payloads (empty choices array, or a null
  // finish_reason from models like Gemini) would otherwise map straight
  // through to null here. When tool-use blocks are present, default to
  // "tool_use" so the client still executes the tools; otherwise "end_turn".
  return {
    id: toAnthropicMessageId(response.id),
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
    stop_reason:
      mapOpenAIStopReasonToAnthropic(correctedStopReason)
      ?? (allToolUseBlocks.length > 0 ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: buildAnthropicUsage(response.usage),
  }
}

function buildAnthropicUsage(usage: ChatCompletionResponse["usage"]) {
  return {
    input_tokens:
      (usage?.prompt_tokens ?? 0)
      - (usage?.prompt_tokens_details?.cached_tokens ?? 0),
    output_tokens: usage?.completion_tokens ?? 0,
    ...(usage?.prompt_tokens_details?.cached_tokens !== undefined && {
      cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens,
    }),
  }
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
  toolNameMap?: ToolNameMap,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    ...toAnthropicToolIdentity(toolCall.function.name, toolNameMap),
    input: parseToolInput(
      toolCall.function.arguments,
      toolCall.function.name,
      toolNameMap?.inputSchemas?.[toolCall.function.name],
    ),
  }))
}
