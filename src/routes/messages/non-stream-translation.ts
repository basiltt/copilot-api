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
import { mapOpenAIStopReasonToAnthropic } from "./utils"

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
  system: string | Array<AnthropicTextBlock> | undefined,
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
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock => block.type === "tool_result",
    )
    const webSearchResultBlocks = message.content.filter(
      (block): block is AnthropicWebSearchToolResultBlock =>
        block.type === "web_search_tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) =>
        block.type !== "tool_result" &&
        block.type !== "web_search_tool_result",
      // document blocks remain here intentionally — mapContent handles them
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapToolResultContent(block.content),
      })
    }

    // Web search result blocks → serialize as user message
    if (webSearchResultBlocks.length > 0) {
      const text = webSearchResultBlocks
        .map((b) => `[Web search result: ${JSON.stringify(b.content)}]`)
        .join("\n\n")
      newMessages.push({ role: "user", content: text })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
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

  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  const serverToolUseBlocks = message.content.filter(
    (block): block is AnthropicServerToolUseBlock =>
      block.type === "server_tool_use",
  )

  // redacted_thinking has no OpenAI equivalent — strip it; server_tool_use is serialised to text by mapContent
  const visibleBlocks = message.content.filter(
    (block): block is Exclude<typeof block, AnthropicRedactedThinkingBlock> =>
      block.type !== "redacted_thinking",
  )

  // Combine text, thinking, and server_tool_use blocks for Branch 1 (tool_calls path)
  // OpenAI doesn't have separate thinking or server_tool_use blocks
  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
    ...serverToolUseBlocks.map((b) => `[Server tool use: ${JSON.stringify(b)}]`),
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
  return mapContent(content as Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>)
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
          || block.type === "thinking"
          || block.type === "document" // user messages: PDF → placeholder
          || block.type === "server_tool_use", // assistant messages: serialise to JSON
      )
      .map((block) => {
        if (block.type === "text") return block.text
        if (block.type === "thinking") return block.thinking
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
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })

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

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
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
    input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
  }))
}
