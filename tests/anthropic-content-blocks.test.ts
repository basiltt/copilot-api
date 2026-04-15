import { describe, test, expect } from "bun:test"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicContainerUploadBlock,
  type AnthropicMessagesPayload,
  type AnthropicSearchResultBlock,
  type AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

describe("New Anthropic content block types (API parity)", () => {
  test("search_result block in user message produces formatted text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What did you find?" },
            {
              type: "search_result",
              source: "https://example.com/article",
              title: "Example Article",
              content: "This is the search result content.",
            } as AnthropicSearchResultBlock,
          ] as Array<AnthropicUserContentBlock>,
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    const content = typeof userMsg?.content === "string" ? userMsg.content : ""
    expect(content).toContain("[Search: Example Article]")
    expect(content).toContain("Source: https://example.com/article")
    expect(content).toContain("This is the search result content.")
  })

  test("container_upload block in user message produces placeholder text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "I uploaded a file." },
            {
              type: "container_upload",
              file_id: "file_abc123",
            } as unknown as AnthropicContainerUploadBlock & {
              type: "container_upload"
            },
          ] as Array<AnthropicUserContentBlock>,
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    const content = typeof userMsg?.content === "string" ? userMsg.content : ""
    expect(content).toContain("[Container upload: file_abc123]")
  })

  test("web_fetch_tool_result block in user message is serialized as user text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Fetch this page." },
        {
          role: "user",
          content: [
            {
              type: "web_fetch_tool_result",
              tool_use_id: "srv_wf_1",
              content: { url: "https://example.com", text: "Page content" },
            } as unknown as AnthropicUserContentBlock,
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const resultMsg = result.messages.find(
      (m) =>
        m.role === "user"
        && typeof m.content === "string"
        && m.content.includes("web_fetch_tool_result"),
    )
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.content).toContain("example.com")
  })

  test("code_execution_tool_result in assistant message with tool calls (Branch 1) appears in text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Run some code." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here are the results." },
            {
              type: "code_execution_tool_result",
              tool_use_id: "srv_ce_1",
              content: { stdout: "Hello World", exit_code: 0 },
            } as unknown as AnthropicAssistantContentBlock,
            {
              type: "tool_use",
              id: "call_1",
              name: "Bash",
              input: { command: "echo done" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "done" },
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const assistantMsg = result.messages.find(
      (m) => m.role === "assistant" && typeof m.content === "string",
    )
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.content).toContain("code_execution_tool_result")
    expect(assistantMsg?.content).toContain("Hello World")
  })
})

describe("New Anthropic content block types — mixed content and image handling", () => {
  test("unknown server tool result in assistant message (Branch 2, no tool_use) goes through mapContent default", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "What happened?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I found something." },
            {
              type: "bash_code_execution_tool_result",
              tool_use_id: "srv_bash_1",
              content: { stdout: "output", exit_code: 0 },
            } as unknown as AnthropicAssistantContentBlock,
          ],
        },
        { role: "user", content: "Continue." },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const assistantMsg = result.messages.find(
      (m) =>
        m.role === "assistant"
        && typeof m.content === "string"
        && m.content.includes("bash_code_execution_tool_result"),
    )
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.content).toContain("output")
  })

  test("search_result in mapContent Path B (mixed with image) produces text part", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this." },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
            {
              type: "search_result",
              source: "https://example.com",
              title: "Mixed Test",
              content: "Search result in image context.",
            } as unknown as AnthropicUserContentBlock,
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    expect(Array.isArray(userMsg?.content)).toBe(true)
    const parts = userMsg?.content as Array<{ type: string; text?: string }>
    expect(parts.some((p) => p.type === "image_url")).toBe(true)
    expect(
      parts.some(
        (p) => p.type === "text" && p.text?.includes("[Search: Mixed Test]"),
      ),
    ).toBe(true)
  })

  test("URL-based image source passes URL directly to image_url", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this image." },
            {
              type: "image",
              source: {
                type: "url",
                url: "https://example.com/image.png",
              },
            },
          ] as Array<AnthropicUserContentBlock>,
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    expect(Array.isArray(userMsg?.content)).toBe(true)
    const parts = userMsg?.content as Array<{
      type: string
      image_url?: { url: string }
    }>
    const imagePart = parts.find((p) => p.type === "image_url")
    expect(imagePart?.image_url?.url).toBe("https://example.com/image.png")
  })

  test("mapContent with image + search_result mix handles both correctly", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this." },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
            {
              type: "search_result",
              source: "https://example.com",
              title: "Mixed Test",
              content: "Search result in image context.",
            } as unknown as AnthropicUserContentBlock,
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    expect(Array.isArray(userMsg?.content)).toBe(true)
    const parts = userMsg?.content as Array<{ type: string; text?: string }>
    expect(parts.some((p) => p.type === "image_url")).toBe(true)
    expect(
      parts.some(
        (p) => p.type === "text" && p.text?.includes("[Search: Mixed Test]"),
      ),
    ).toBe(true)
  })

  test("web_search_tool_result is routed through server tool result path (not mapContent)", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srv_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com",
                  title: "Test",
                },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    // Should produce a user message with serialized content (not a tool message)
    const userMsg = result.messages.find(
      (m) => m.role === "user" && typeof m.content === "string",
    )
    expect(userMsg).toBeDefined()
    expect(userMsg?.content).toContain("web_search_tool_result")
    // Should NOT produce a tool message (tool_result routing is separate)
    const toolMsg = result.messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeUndefined()
  })
})
