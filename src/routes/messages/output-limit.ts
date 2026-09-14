import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import type { AnthropicToolUseBlock } from "./anthropic-types"

import { parseToolInput } from "./tool-input"
import { toAnthropicToolIdentity, type ToolNameMap } from "./tool-name-mapping"

export const OUTPUT_LIMIT_VISIBLE_TEXT =
  "The upstream model reached its output token limit before completing the "
  + "response. Do not execute unfinished tool input. Retry with a larger "
  + "client output-token budget if available; otherwise use smaller complete "
  + "tool operations instead of repeating the unchanged oversized call."

const truncatedToolCallOmissions = Symbol("truncatedToolCallOmissions")

type UpstreamFinishReason = "stop" | "length" | "tool_calls" | "content_filter"

type CompletionMessage =
  ChatCompletionResponse["choices"][number]["message"] & {
    [truncatedToolCallOmissions]?: number
  }

export function markTruncatedToolCallOmissions(
  message: ChatCompletionResponse["choices"][number]["message"],
  count: number,
): void {
  if (count <= 0) return
  Object.defineProperty(message, truncatedToolCallOmissions, {
    value: count,
    enumerable: false,
  })
}

export function getTruncatedToolCallOmissionCount(
  message: ChatCompletionResponse["choices"][number]["message"],
): number {
  return (message as CompletionMessage)[truncatedToolCallOmissions] ?? 0
}

export function selectOutputStopReason(
  current: UpstreamFinishReason | null,
  next: UpstreamFinishReason,
): UpstreamFinishReason {
  if (next === "content_filter" || current === "content_filter")
    return "content_filter"
  if (next === "length" || current === "length") return "length"
  if (next === "tool_calls" || current === "stop") return next
  return current ?? next
}

/**
 * Preserve a syntactically valid partial tool object for Anthropic's
 * max_tokens continuation contract without treating it as a completed call.
 */
export function truncatedToolUseBlocks(
  toolCalls:
    | ChatCompletionResponse["choices"][number]["message"]["tool_calls"]
    | undefined,
  toolNameMap?: ToolNameMap,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls?.length) return []

  try {
    return toolCalls.map((toolCall) => {
      if (!toolCall.id || !toolCall.function.name)
        throw new Error("Incomplete tool identity")
      return {
        type: "tool_use",
        id: toolCall.id,
        ...toAnthropicToolIdentity(toolCall.function.name, toolNameMap),
        input: parseToolInput(
          toolCall.function.arguments,
          toolCall.function.name,
        ),
      }
    })
  } catch {
    // A malformed/non-object argument stream cannot be represented as a valid
    // Anthropic content block. Omit the whole batch rather than fabricate it.
    return []
  }
}
