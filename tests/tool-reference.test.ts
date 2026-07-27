import { describe, expect, test } from "bun:test"

import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

describe("Claude Code tool_reference compatibility", () => {
  test("preserves client-side ToolSearch references in tool results", () => {
    const translated = translateToOpenAI({
      model: "claude-opus-5",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_search",
              name: "ToolSearch",
              input: { query: "select:WebFetch" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_search",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "WebFetch",
                },
              ],
            },
          ],
        },
      ],
      tools: [
        {
          name: "ToolSearch",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        {
          name: "WebFetch",
          defer_loading: true,
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
              prompt: { type: "string" },
            },
            required: ["url", "prompt"],
          },
        },
      ],
    })

    expect(translated.messages).toContainEqual({
      role: "tool",
      tool_call_id: "toolu_search",
      content: "[Tool loaded: WebFetch]",
    })
    expect(translated.tools?.map((tool) => tool.function.name)).toEqual([
      "ToolSearch",
      "WebFetch",
    ])
  })
})
