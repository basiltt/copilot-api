import { describe, test, expect } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Message } from "~/services/copilot/create-chat-completions"

import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

/**
 * Regression tests for two message-array invariant violations that broke
 * Claude Code's multi-agent / workflow ("ultracode") mode against the Copilot
 * Claude backend.  Both manifest as `invalid_request_body` 400s.
 *
 * Bug A — assistant message prefill:
 *   A request whose final Anthropic message has role:"assistant" (a "prefill"
 *   priming the reply) is translated into an OpenAI array that also ends with
 *   an assistant message.  Copilot's Claude backend rejects this:
 *     "This model does not support assistant message prefill. The conversation
 *      must end with a user message."
 *
 * Bug B — merge drops tool_calls:
 *   mergeConsecutiveSameRoleMessages merges two consecutive assistant messages
 *   by copying only `.content`, silently dropping the second message's
 *   `tool_calls`.  A following tool_result then has no owning assistant turn:
 *     "messages with role 'tool' must be a response to a preceeding message
 *      with 'tool_calls'."
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

describe("Bug A: assistant prefill normalization", () => {
  test("never emits a trailing assistant message — conversation must end with user", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Write a haiku about the sea." },
        { role: "assistant", content: [{ type: "text", text: "Here it is:" }] },
      ],
    }

    const result = translateToOpenAI(payload)

    expect(result.messages.at(-1)?.role).not.toBe("assistant")
  })

  test("preserves the prefill text when normalizing a trailing assistant", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Continue the story." },
        {
          role: "assistant",
          content: [{ type: "text", text: "Once upon a time" }],
        },
      ],
    }

    const result = translateToOpenAI(payload)

    // The prefill content must survive somewhere in the array (not dropped).
    expect(JSON.stringify(result.messages)).toContain("Once upon a time")
    // And it must still end with a user turn.
    expect(result.messages.at(-1)?.role).toBe("user")
  })

  test("does NOT append a continuation when the conversation already ends with user", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "First." },
        { role: "assistant", content: [{ type: "text", text: "Reply." }] },
        { role: "user", content: "Second." },
      ],
    }

    const result = translateToOpenAI(payload)

    // Last message is the genuine user turn, unchanged.
    expect(result.messages.at(-1)?.role).toBe("user")
    expect(result.messages.at(-1)?.content).toContain("Second.")
    // Exactly system?+user+assistant+user — no spurious extra message.
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(2)
  })

  test("does NOT strand an assistant turn that has pending tool_calls", () => {
    // An assistant message whose last block is a tool_use is NOT a prefill —
    // appending a user message here would orphan the tool_calls. This shape is
    // degenerate as a final message, but the normalization must never create an
    // assistant(tool_calls) → user adjacency.
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Run it." },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_pending", name: "run", input: {} },
          ],
        },
      ],
    }

    const result = translateToOpenAI(payload)

    const last = result.messages.at(-1)
    // If we appended a user message, it must not directly follow an assistant
    // that still has unanswered tool_calls.
    if (last?.role === "user") {
      const prev = result.messages.at(-2)
      expect(prev?.tool_calls?.length ?? 0).toBe(0)
    }
  })
})

describe("Bug B: merge must not drop tool_calls", () => {
  test("merging consecutive assistant messages keeps tool_calls so the tool_result stays anchored", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Do it." },
        { role: "assistant", content: [{ type: "text", text: "Thinking..." }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "run", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
          ],
        },
      ],
    }

    const result = translateToOpenAI(payload)

    // The tool_call id must still be produced by some assistant turn.
    const callIds = new Set(toolCallIds(result.messages))
    expect(callIds.has("toolu_1")).toBe(true)

    // Every tool message must reference a known assistant tool_call.
    for (const id of toolResultIds(result.messages)) {
      expect(callIds.has(id)).toBe(true)
    }
  })

  test("the tool message immediately follows an assistant bearing matching tool_calls", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Go." },
        { role: "assistant", content: [{ type: "text", text: "Step one." }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_x", name: "do", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_x", content: "ok" },
          ],
        },
      ],
    }

    const result = translateToOpenAI(payload)

    const toolIndex = result.messages.findIndex((m) => m.role === "tool")
    expect(toolIndex).toBeGreaterThan(0)
    const owner = result.messages[toolIndex - 1]
    expect(owner.role).toBe("assistant")
    expect(owner.tool_calls?.map((tc) => tc.id)).toContain("toolu_x")
  })

  test("collapses consecutive assistants into one turn — no adjacent same-role messages, text preserved", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Do it." },
        { role: "assistant", content: [{ type: "text", text: "Thinking..." }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "run", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
          ],
        },
      ],
    }

    const result = translateToOpenAI(payload)

    // No two adjacent messages share a role (Copilot expects alternation).
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i].role).not.toBe(result.messages[i - 1].role)
    }
    // The preceding assistant text must not be lost in the collapse.
    expect(JSON.stringify(result.messages)).toContain("Thinking...")
  })
})
