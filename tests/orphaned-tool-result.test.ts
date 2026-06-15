import { describe, test, expect } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Message } from "~/services/copilot/create-chat-completions"

import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

/**
 * Regression tests for orphaned tool_result blocks on the Anthropic →
 * Chat Completions path (used by Claude models).
 *
 * Copilot's backend re-converts our OpenAI payload back to Anthropic for
 * Claude models and strictly validates that every tool_result references a
 * tool_use in the immediately-preceding assistant message:
 *
 *   "messages.N.content.0: unexpected tool_use_id found in tool_result blocks:
 *    toolu_xxx. Each tool_result block must have a corresponding tool_use
 *    block in the previous message."  (code: invalid_request_body)
 *
 * Orphaned tool_result blocks arise when conversation history is edited —
 * context compaction drops an assistant tool_use turn, a parallel/interrupted
 * tool call is cancelled, etc. The translation must not forward a `tool`
 * message whose tool_call_id has no matching assistant tool_calls entry.
 */

function toolCallIds(messages: Array<Message>): Array<string> {
  return messages
    .filter((m) => m.role === "assistant" && m.tool_calls)
    .flatMap((m) => m.tool_calls ?? [])
    .map((tc) => tc.id)
}

function toolResultIds(messages: Array<Message>): Array<string> {
  return messages
    .filter((m) => m.role === "tool")
    .map((m) => m.tool_call_id)
    .filter((id): id is string => id !== undefined)
}

describe("orphaned tool_result repair (Chat Completions path)", () => {
  test("drops a tool_result whose tool_use was removed by compaction", () => {
    // messages[0] user, messages[1] assistant (plain text — NO tool_use),
    // messages[2] user with an orphaned tool_result. This is exactly the
    // shape Copilot rejected: messages.2.content.0 references a tool_use_id
    // that has no corresponding tool_use in messages[1].
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Run the build." },
        {
          role: "assistant",
          content: [{ type: "text", text: "Okay, here is the summary." }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01XqGuK9chsSnyoedsgjS4Xf",
              content: "build output",
            },
            { type: "text", text: "Continue please." },
          ],
        },
      ],
    }

    const result = translateToOpenAI(payload)

    // No tool message may reference an id that no assistant turn produced.
    const callIds = new Set(toolCallIds(result.messages))
    for (const resultId of toolResultIds(result.messages)) {
      expect(callIds.has(resultId)).toBe(true)
    }
    // The orphaned id specifically must be gone.
    expect(toolResultIds(result.messages)).not.toContain(
      "toolu_01XqGuK9chsSnyoedsgjS4Xf",
    )
    // The accompanying user text must survive (not silently dropped).
    const serialized = JSON.stringify(result.messages)
    expect(serialized).toContain("Continue please.")
  })

  test("keeps a properly paired tool_use → tool_result intact", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_weather_1",
              name: "get_weather",
              input: { city: "London" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_weather_1",
              content: "15C",
            },
          ],
        },
      ],
    }

    const result = translateToOpenAI(payload)

    const callIds = new Set(toolCallIds(result.messages))
    expect(callIds.has("toolu_weather_1")).toBe(true)
    expect(toolResultIds(result.messages)).toContain("toolu_weather_1")
  })

  test("drops only the orphan when paired and orphaned results are mixed", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Do two things." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_keep",
              name: "do_thing",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_keep", content: "ok" },
            {
              type: "tool_result",
              tool_use_id: "toolu_orphan",
              content: "stale",
            },
          ],
        },
      ],
    }

    const result = translateToOpenAI(payload)

    const ids = toolResultIds(result.messages)
    expect(ids).toContain("toolu_keep")
    expect(ids).not.toContain("toolu_orphan")
  })

  test("produces no consecutive same-role messages after converting an orphan", () => {
    // An orphan converted to a `user` role must not leave two adjacent user
    // messages — Copilot expects strictly alternating roles.  Repair runs
    // before the consecutive-role merge so the converted message coalesces.
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Start." },
        { role: "assistant", content: [{ type: "text", text: "Summary." }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_gone",
              content: "leftover",
            },
          ],
        },
        { role: "user", content: "Next instruction." },
      ],
    }

    const result = translateToOpenAI(payload)

    // No two consecutive messages share a role.
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i].role).not.toBe(result.messages[i - 1].role)
    }
    // No tool message survives without a matching tool_use.
    expect(toolResultIds(result.messages)).toHaveLength(0)
  })
})
