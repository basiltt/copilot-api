import { describe, test, expect } from "bun:test"

import { translateFromResponsesPayloadToCC } from "~/services/copilot/responses-translation"

/**
 * The OpenAI Responses API accepts `input` as either a plain string (shorthand
 * for a single user message) or an array of typed input items.  The ChatGPT
 * desktop app and Codex both send the string form for simple turns.
 *
 * The string case used to fall into `for (const item of payload.input)`, which
 * iterates a string's *characters* — each translating to nothing.  The result
 * was an empty `messages` array and a hard upstream
 * `400 "messages must be non-empty"` for every non-native model routed through
 * the Chat Completions translation path (all Claude and Gemini models).
 */
describe("Responses → Chat Completions: `input` shorthand", () => {
  test("translates a plain-string input into a single user message", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "say hi in 3 words",
    })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: "user",
      content: "say hi in 3 words",
    })
  })

  test("keeps instructions as a system message ahead of string input", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "hello",
      instructions: "You are terse.",
    })

    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are terse.",
    })
    expect(result.messages[1]).toEqual({ role: "user", content: "hello" })
  })

  test("does not emit an empty user message for an empty string", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "",
      instructions: "You are terse.",
    })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.role).toBe("system")
  })

  test("still handles the array form", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "say hi" }],
        },
      ],
    })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.role).toBe("user")
  })

  test("never produces an empty messages array for non-empty string input", () => {
    // The precise upstream failure this guards against.
    const result = translateFromResponsesPayloadToCC({
      model: "gemini-3.6-flash",
      input: "anything",
    })

    expect(result.messages.length).toBeGreaterThan(0)
  })
})
