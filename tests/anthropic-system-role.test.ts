import { describe, expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicSystemMessage,
} from "~/routes/messages/anthropic-types"

import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import { validateAnthropicPayload } from "~/routes/messages/validate-payload"

// Regression tests for the third Anthropic message role, "system".
//
// The Claude app / Claude Code (v1.24012.92+) sends mid-conversation system
// instructions as `role: "system"` messages inside messages[] (and as
// `mid_conv_system` content blocks inside user messages). The proxy previously
// rejected these with `400 messages.N.role: must be either "user" or
// "assistant"`, which the client "recovers" from by silently disabling the
// feature — degrading the conversation.
describe("Anthropic system-role messages", () => {
  test("validateAnthropicPayload accepts role: system in messages[]", () => {
    const error = validateAnthropicPayload({
      model: "claude-opus-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "Be concise." },
        { role: "user", content: "go" },
      ],
    })
    expect(error).toBeUndefined()
  })

  test("validateAnthropicPayload still rejects a missing/non-string role", () => {
    expect(
      validateAnthropicPayload({
        model: "claude-opus-5",
        max_tokens: 100,
        messages: [{ content: "no role here" }],
      }),
    ).toContain("must be a non-empty string")

    expect(
      validateAnthropicPayload({
        model: "claude-opus-5",
        max_tokens: 100,
        messages: [{ role: 42, content: "bad role type" }],
      }),
    ).toContain("must be a non-empty string")
  })

  test("translateToOpenAI maps a system-role message to an OpenAI system message in place", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "system",
          content: "Updated instructions: always answer in French.",
        } as AnthropicSystemMessage,
        { role: "user", content: "go" },
      ],
    }

    const result = translateToOpenAI(payload)

    const systemMessages = result.messages.filter((m) => m.role === "system")
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]?.content).toBe(
      "Updated instructions: always answer in French.",
    )
    // The instruction keeps its mid-conversation placement (after the first
    // user turn), and the conversation still ends with a user turn.
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "system",
      "user",
    ])
  })

  test("translateToOpenAI extracts text from a system-role message with block content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "system",
          content: [{ type: "text", text: "Stay on topic." }],
        } as AnthropicSystemMessage,
      ],
    }

    const result = translateToOpenAI(payload)
    const systemMessages = result.messages.filter((m) => m.role === "system")
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]?.content).toBe("Stay on topic.")
  })

  test("translateToOpenAI surfaces mid_conv_system block text embedded in a user message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-5",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            {
              type: "mid_conv_system",
              content: [{ type: "text", text: "new rules apply" }],
            },
          ],
        },
      ],
    }

    const result = translateToOpenAI(payload)
    const userMessage = result.messages.find((m) => m.role === "user")
    expect(userMessage).toBeDefined()
    expect(userMessage?.content).toContain("hello")
    expect(userMessage?.content).toContain("new rules apply")
    // The embedded system instruction is surfaced as readable text, not an
    // opaque JSON dump.
    expect(userMessage?.content).not.toContain("mid_conv_system")
  })
})
