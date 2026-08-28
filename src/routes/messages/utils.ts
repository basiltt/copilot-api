import { type AnthropicResponse } from "./anthropic-types"

export const EMPTY_VISIBLE_OUTPUT_TEXT =
  "The upstream model completed the turn without producing a visible response. "
  + "Please retry or rephrase the request."

export const FILTERED_VISIBLE_OUTPUT_TEXT =
  "The upstream model declined to provide a response because the request was "
  + "filtered by its safety policy."

export function mapOpenAIStopReasonToAnthropic(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "refusal",
  } as const
  return stopReasonMap[finishReason]
}

/**
 * Converts a Copilot/OpenAI response ID (e.g. "chatcmpl-xxx" or "resp_xxx")
 * into an Anthropic-style message ID with the "msg_" prefix.
 *
 * Claude Code uses the "msg_" prefix to identify valid message IDs when
 * persisting and restoring conversation history (e.g. across VS Code
 * window reloads). Without this prefix the conversation is treated as
 * invalid and history is lost on reload.
 */
export function toAnthropicMessageId(upstreamId: string): string {
  if (upstreamId.startsWith("msg_")) return upstreamId
  return `msg_${upstreamId}`
}
