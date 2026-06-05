import { describe, test, expect } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

const LONG_MCP_TOOL_NAME =
  "mcp__plugin_chrome-devtools-mcp_chrome-devtools__get_console_message"

describe("Anthropic tool name aliasing", () => {
  test("aliases long MCP tool names consistently across request fields", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: "Inspect the browser console." },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Checking the browser console now.",
            },
            {
              type: "tool_use",
              id: "toolu_1",
              name: LONG_MCP_TOOL_NAME,
              input: { request_id: "req_1" },
            },
          ],
        },
      ],
      max_tokens: 1000,
      tools: [
        {
          name: LONG_MCP_TOOL_NAME,
          description: "Fetch a console message from the browser session.",
          input_schema: {
            type: "object",
            properties: {
              request_id: { type: "string" },
            },
            required: ["request_id"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: "tool", name: LONG_MCP_TOOL_NAME },
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    const aliasedName = openAIPayload.tools?.[0]?.function.name
    expect(aliasedName).toBeDefined()
    expect(aliasedName).not.toBe(LONG_MCP_TOOL_NAME)
    expect(aliasedName).toMatch(/^[\w-]{1,64}$/)

    expect(openAIPayload.tool_choice).toEqual({
      type: "function",
      function: { name: aliasedName as string },
    })

    const assistantMessage = openAIPayload.messages.find(
      (message) => message.role === "assistant",
    )
    expect(assistantMessage?.tool_calls?.[0]?.function.name).toBe(aliasedName)
  })
})
