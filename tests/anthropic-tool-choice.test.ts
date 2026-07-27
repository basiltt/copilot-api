import { describe, test, expect } from "bun:test"

import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

/**
 * Copilot hard-rejects a payload carrying `tool_choice` without a non-empty
 * `tools` array: `400 "tools are required when tool choice is specified"`.
 *
 * Claude Desktop / Cowork routinely sends `tool_choice: {type: "auto"}`
 * alongside *only* server-side typed tools (e.g. `web_search_20250305`).
 * Those typed tools are filtered out during translation, which used to leave
 * an orphaned `tool_choice` and fail the entire turn — including every web
 * search the desktop app attempted.
 */
describe("tool_choice / tools invariant", () => {
  test("drops tool_choice when no tools are provided", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      tool_choice: { type: "auto" },
    })
    expect(result.tools).toBeUndefined()
    expect(result.tool_choice).toBeUndefined()
  })

  test("drops tool_choice when tools contains only server-side typed tools", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Search for news" }],
      max_tokens: 100,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "auto" },
    })
    expect(result.tools).toBeUndefined()
    expect(result.tool_choice).toBeUndefined()
  })

  test("drops tool_choice when tools is an empty array", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      tools: [],
      tool_choice: { type: "any" },
    })
    expect(result.tools).toBeUndefined()
    expect(result.tool_choice).toBeUndefined()
  })

  test("drops tool_choice: none when no tools survive translation", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      tool_choice: { type: "none" },
    })
    expect(result.tool_choice).toBeUndefined()
  })

  test("preserves tool_choice when a real custom tool survives translation", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Weather?" }],
      max_tokens: 100,
      tools: [
        {
          name: "get_weather",
          description: "Gets weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
      tool_choice: { type: "auto" },
    })
    expect(result.tools).toHaveLength(1)
    expect(result.tool_choice).toBe("auto")
  })

  test("preserves tool_choice alongside a mix of typed and custom tools", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Weather?" }],
      max_tokens: 100,
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        {
          name: "get_weather",
          description: "Gets weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
      tool_choice: { type: "any" },
    })
    expect(result.tools).toHaveLength(1)
    expect(result.tool_choice).toBe("required")
  })
})
