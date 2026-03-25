import consola from "consola"

import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicCustomTool,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicRedactedThinkingBlock,
  type AnthropicResponse,
  type AnthropicServerToolUseBlock,
  type AnthropicSystemBlock,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
  type AnthropicWebSearchToolResultBlock,
  isTypedTool,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic, toAnthropicMessageId } from "./utils"

const MAX_TOOL_RESULT_CHARS = 20_000
const TOOL_RESULT_HEAD_CHARS = 5_000
const TOOL_RESULT_MIDDLE_CHARS = 3_000
const TOOL_RESULT_TAIL_CHARS = 5_000

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  return {
    model: translateModelName(payload.model),
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system,
    ),
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
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
  }
}

function translateModelName(model: string): string {
  // Normalize claude-{family}-4-{minor}[-extra] → claude-{family}-4
  // Only applies to generation 4+ where minor version numbers are subagent-build-specific.
  // eslint-disable-next-line regexp/no-super-linear-backtracking, regexp/optimal-quantifier-concatenation
  return model.replace(/^(claude-[a-z]+-4)-\d+.*$/, "$1")
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicSystemBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === "user" ?
      handleUserMessage(message)
    : handleAssistantMessage(message),
  )

  return [...systemMessages, ...otherMessages]
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

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []
  const deferredUserContents: Array<string | Array<ContentPart>> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const webSearchResultBlocks = message.content.filter(
      (block): block is AnthropicWebSearchToolResultBlock =>
        block.type === "web_search_tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) =>
        block.type !== "tool_result" && block.type !== "web_search_tool_result",
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

    // Web search result blocks → serialize as user message
    if (webSearchResultBlocks.length > 0) {
      const text = webSearchResultBlocks
        .map((b) => `[Web search result: ${JSON.stringify(b.content)}]`)
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
  ]
    .filter(Boolean) // strip empty strings to avoid spurious \n\n
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
              name: toolUse.name,
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
  // Safe cast: AnthropicToolResultBlock content array is Array<TextBlock|ImageBlock|DocumentBlock>,
  // all of which are members of AnthropicUserContentBlock — mapContent handles them correctly.
  return mapContent(
    content as Array<
      AnthropicUserContentBlock | AnthropicAssistantContentBlock
    >,
  )
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
    followUpUserContent: mapContent(
      content as Array<
        AnthropicUserContentBlock | AnthropicAssistantContentBlock
      >,
    ),
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
      .filter(
        (block) =>
          block.type === "text"
          || block.type === "document" // user messages: PDF → placeholder
          || block.type === "server_tool_use", // assistant messages: serialise to JSON
      )
      .map((block) => {
        if (block.type === "text") return block.text
        if (block.type === "document")
          return "[Document: PDF content not displayable]"
        // server_tool_use
        return `[Server tool use: ${JSON.stringify(block)}]`
      })
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })

        break
      }
      case "document": {
        contentParts.push({
          type: "text",
          text: "[Document: PDF content not displayable]",
        })

        break
      }
      case "server_tool_use": {
        contentParts.push({
          type: "text",
          text: `[Server tool use: ${JSON.stringify(block)}]`,
        })

        break
      }
      // redacted_thinking: silently skip — opaque binary data, no OpenAI equivalent
      // No default
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }

  const customTools: Array<Tool> = anthropicTools
    .filter((tool): tool is AnthropicCustomTool => !isTypedTool(tool))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        // Forward strict for Structured Outputs; strip all other extra fields
        // (cache_control, defer_loading, input_examples, eager_input_streaming)
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }))
  // Return undefined (not []) when all tools are typed — an empty tools array with an active
  // tool_choice would produce a malformed OpenAI request.
  return customTools.length > 0 ? customTools : undefined
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
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
          function: { name: anthropicToolChoice.name },
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
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  // Note: GitHub Copilot doesn't generate thinking blocks, so we don't include them in responses

  // Some models (notably Gemini) intermittently return finish_reason "stop"
  // even when they emitted tool calls. Correct this to "tool_calls" so Claude
  // Code executes the pending tool calls instead of treating the turn as done.
  const correctedStopReason =
    allToolUseBlocks.length > 0 && stopReason === "stop" ?
      "tool_calls"
    : stopReason

  // Guard: detect truncated tool calls when finish_reason is "length".
  // When the output hits the token limit mid-tool-call, the JSON arguments are
  // incomplete.  safeParseJson silently returns {} for these, which would cause
  // Claude Code to execute a tool with empty/wrong input.  Instead, replace the
  // broken tool use blocks with an explanatory text block and return "end_turn"
  // so Claude Code reads the feedback and adjusts its strategy.
  if (correctedStopReason === "length" && allToolUseBlocks.length > 0) {
    const hasTruncated = response.choices.some((choice) =>
      choice.message.tool_calls?.some((tc) => {
        if (!tc.function.arguments) return false
        try {
          JSON.parse(tc.function.arguments)
          return false
        } catch {
          return true
        }
      }),
    )

    if (hasTruncated) {
      const toolName = allToolUseBlocks[0].name
      consola.debug(
        `[non-stream] Truncated tool call detected for "${toolName}" — `
          + `replacing with explanatory text`,
      )
      return {
        id: toAnthropicMessageId(response.id),
        type: "message",
        role: "assistant",
        model: response.model,
        content: [
          ...allTextBlocks,
          {
            type: "text",
            text:
              `[Output truncated: the response exceeded the maximum output token limit`
              + ` while generating tool call "${toolName}".`
              + ` Please retry with a smaller output, e.g. write the file in smaller chunks.]`,
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: buildAnthropicUsage(response.usage),
      }
    }
  }

  return {
    id: toAnthropicMessageId(response.id),
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(correctedStopReason),
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
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.function.name,
    input: safeParseJson(toolCall.function.arguments),
  }))
}

function safeParseJson(json: string): Record<string, unknown> {
  if (!json) return {}
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}
