import type { Message } from "~/services/copilot/create-chat-completions"

/**
 * Repairs orphaned tool calls/results in an OpenAI-format message array so the
 * upstream (Copilot, and its internal Anthropic re-validation for Claude
 * models) does not reject the request.
 *
 * Anthropic enforces a strict invariant: every `tool_result` must reference a
 * `tool_use` in the immediately-preceding assistant message, and every
 * `tool_use` must be followed by its `tool_result`.  Editing conversation
 * history breaks this — context compaction can drop an assistant tool_use
 * turn, and interrupted/parallel tool calls can leave a result without its
 * call (or a call without its result).  Forwarding either shape yields:
 *
 *   "unexpected tool_use_id found in tool_result blocks: toolu_xxx. Each
 *    tool_result block must have a corresponding tool_use block in the previous
 *    message."  (code: invalid_request_body)
 *
 * Two complementary repairs, both operating on `role:"tool"` runs that follow
 * an `assistant` message bearing `tool_calls`:
 *  - {@link removeOrphanedResults}: drop `tool` messages whose `tool_call_id`
 *    is not among the assistant's `tool_calls` ids.  These are stale/partial
 *    results from a real parallel batch — their content is throwaway and
 *    deleting them keeps the valid siblings adjacent to their assistant turn.
 *  - {@link insertMissingResults}: synthesize empty placeholder `tool` messages
 *    for assistant `tool_calls` ids that have no result, so no call dangles.
 *
 * A trailing `tool` message that does NOT follow an assistant turn with
 * tool_calls (the common case after context compaction drops the assistant
 * tool_use turn) is *converted* to a plain user message rather than deleted —
 * Claude Code frequently bundles real user text into that same message, so
 * dropping it would silently lose the user's instruction.  Converting away
 * from the `tool` role satisfies the invariant while preserving content.
 *
 * Mutates `messages` in place.
 */

interface RepairRange {
  messages: Array<Message>
  start: number
  end: number
  callIds: Set<string>
}

function removeOrphanedResults(range: RepairRange): number {
  const { messages, start, callIds } = range
  let j = range.end
  for (let k = j - start - 2; k >= 0; k--) {
    const id = messages[start + 1 + k].tool_call_id
    if (id && !callIds.has(id)) {
      messages.splice(start + 1 + k, 1)
      j--
    }
  }
  return j
}

function insertMissingResults(range: RepairRange): number {
  const { messages, start, end, callIds } = range
  const existingIds = new Set(
    messages
      .slice(start + 1, end)
      .map((m) => m.tool_call_id)
      .filter(Boolean),
  )
  const missing = [...callIds].filter((id) => !existingIds.has(id))
  if (missing.length > 0) {
    const placeholders = missing.map((id) => ({
      role: "tool" as const,
      tool_call_id: id,
      content: "",
    }))
    messages.splice(start + 1, 0, ...placeholders)
    return end + missing.length
  }
  return end
}

/**
 * Converts an orphaned `tool` message (no preceding assistant tool_calls) into
 * a plain user message in place, preserving its content so bundled user text
 * is not lost.  Empty-content orphans are dropped entirely (nothing to keep).
 *
 * Returns true if the message was converted (caller should advance past it),
 * false if it was removed (caller should re-check the same index).
 */
function convertOrphanedResultToUser(
  messages: Array<Message>,
  index: number,
): boolean {
  const msg = messages[index]
  const hasContent =
    typeof msg.content === "string" ?
      msg.content.trim().length > 0
    : Array.isArray(msg.content) && msg.content.length > 0

  if (!hasContent) {
    messages.splice(index, 1)
    return false
  }

  messages[index] = { role: "user", content: msg.content }
  return true
}

export function repairOrphanedToolCalls(messages: Array<Message>): void {
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const callIds = new Set(msg.tool_calls.map((tc) => tc.id))

      let j = i + 1
      while (j < messages.length && messages[j].role === "tool") j++

      const range: RepairRange = { messages, start: i, end: j, callIds }
      j = removeOrphanedResults(range)
      range.end = j
      j = insertMissingResults(range)

      i = j
      continue
    }

    if (msg.role === "tool" && msg.tool_call_id) {
      const prev = i > 0 ? messages[i - 1] : null
      if (!prev || prev.role !== "assistant" || !prev.tool_calls?.length) {
        // Orphan with no owning assistant turn — preserve any bundled user
        // text by converting to a user message instead of discarding it.
        if (convertOrphanedResultToUser(messages, i)) i++
        continue
      }
    }

    i++
  }
}
