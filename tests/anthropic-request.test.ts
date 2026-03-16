import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { translateToOpenAI } from "../src/routes/messages/non-stream-translation"

// Zod schema for a single message in the chat completion request.
const messageSchema = z.object({
  role: z.enum([
    "system",
    "user",
    "assistant",
    "tool",
    "function",
    "developer",
  ]),
  content: z.union([z.string(), z.object({}), z.array(z.any())]),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
})

// Zod schema for the entire chat completion request payload.
// This is derived from the openapi.documented.yml specification.
const chatCompletionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1, "Messages array cannot be empty."),
  model: z.string(),
  frequency_penalty: z.number().min(-2).max(2).optional().nullable(),
  logit_bias: z.record(z.string(), z.number()).optional().nullable(),
  logprobs: z.boolean().optional().nullable(),
  top_logprobs: z.number().int().min(0).max(20).optional().nullable(),
  max_tokens: z.number().int().optional().nullable(),
  n: z.number().int().min(1).max(128).optional().nullable(),
  presence_penalty: z.number().min(-2).max(2).optional().nullable(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object", "json_schema"]),
      json_schema: z.object({}).optional(),
    })
    .optional(),
  seed: z.number().int().optional().nullable(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .nullable(),
  stream: z.boolean().optional().nullable(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.object({})]).optional(),
  user: z.string().optional(),
})

/**
 * Validates if a request payload conforms to the OpenAI Chat Completion v1 shape using Zod.
 * @param payload The request payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidChatCompletionRequest(payload: unknown): boolean {
  const result = chatCompletionRequestSchema.safeParse(payload)
  return result.success
}

describe("Anthropic to OpenAI translation logic", () => {
  test("should translate minimal Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should translate comprehensive Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "What is the weather like in Boston?" },
        {
          role: "assistant",
          content: "The weather in Boston is sunny and 75°F.",
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      stream: false,
      metadata: { user_id: "user-123" },
      tools: [
        {
          name: "getWeather",
          description: "Gets weather info",
          input_schema: { location: { type: "string" } },
        },
      ],
      tool_choice: { type: "auto" },
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should handle missing fields gracefully", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should handle invalid types in Anthropic payload", () => {
    const anthropicPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    // @ts-expect-error intended to be invalid
    const openAIPayload = translateToOpenAI(anthropicPayload)
    // Should fail validation
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(false)
  })

  test("should handle thinking blocks in assistant messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this simple math problem...",
            },
            { type: "text", text: "2+2 equals 4." },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is combined with text content
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.content).toContain(
      "Let me think about this simple math problem...",
    )
    expect(assistantMessage?.content).toContain("2+2 equals 4.")
  })

  test("should handle thinking blocks with tool calls", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "I need to call the weather API to get current weather information.",
            },
            { type: "text", text: "I'll check the weather for you." },
            {
              type: "tool_use",
              id: "call_123",
              name: "get_weather",
              input: { location: "New York" },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is included in the message content
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.content).toContain(
      "I need to call the weather API",
    )
    expect(assistantMessage?.content).toContain(
      "I'll check the weather for you.",
    )
    expect(assistantMessage?.tool_calls).toHaveLength(1)
    expect(assistantMessage?.tool_calls?.[0].function.name).toBe("get_weather")
  })

  test("should filter out Anthropic typed tools (no input_schema) from tools array", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      tools: [
        // Custom tool — should be kept
        {
          name: "Bash",
          description: "Run shell commands",
          input_schema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        // Anthropic-typed tool — should be filtered
        { type: "bash_20250124", name: "bash" } as unknown as Parameters<
          typeof translateToOpenAI
        >[0]["tools"][0],
      ],
    }
    const result = translateToOpenAI(anthropicPayload)
    // Only the custom "Bash" tool survives
    expect(result.tools).toHaveLength(1)
    expect(result.tools?.[0].function.name).toBe("Bash")
  })
})

describe("Anthropic new content block types (Task 6)", () => {
  test("document block in user message produces placeholder text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize this PDF." },
            {
              type: "document",
              title: "My Report",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "JVBERi0x",
              },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    expect(typeof userMsg?.content).toBe("string")
    const content = userMsg?.content as string
    expect(content).toContain("Summarize this PDF.")
    expect(content).toContain("[Document: PDF content not displayable]")
  })

  test("server_tool_use block in assistant message is serialized to text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Search for something." },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srv_1",
              name: "web_search",
              input: { query: "test" },
            },
            { type: "text", text: "I searched for you." },
          ],
        },
        { role: "user", content: "Thanks." },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    const content = assistantMsg?.content as string
    expect(content).toContain("[Server tool use:")
    expect(content).toContain("web_search")
    expect(content).toContain("I searched for you.")
  })
})

describe("Anthropic new content block types (Task 2)", () => {
  test("should handle document blocks in user messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What does this PDF say?" },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "JVBERi0x",
              },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    // Should not throw; document block is converted to placeholder text
    expect(() => translateToOpenAI(anthropicPayload)).not.toThrow()
    const result = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(result)).toBe(true)
    // Placeholder text must appear in the message content
    const userMsg = result.messages.find((m) => m.role === "user")
    expect(typeof userMsg?.content).toBe("string")
    expect(userMsg?.content as string).toContain(
      "[Document: PDF content not displayable]",
    )
  })

  test("should handle redacted_thinking blocks in assistant messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Think hard about this." },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "EncryptedThinkingData==" },
            { type: "text", text: "Here is my answer." },
          ],
        },
        { role: "user", content: "Follow up." },
      ],
      max_tokens: 100,
    }
    expect(() => translateToOpenAI(anthropicPayload)).not.toThrow()
    const result = translateToOpenAI(anthropicPayload)
    // The redacted_thinking block is stripped; only the text block survives
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    expect(assistantMsg?.content).toContain("Here is my answer.")
    // redacted_thinking data must NOT appear as raw base64
    expect(assistantMsg?.content as string).not.toContain(
      "EncryptedThinkingData==",
    )
  })
})

describe("handleAssistantMessage redacted_thinking and server_tool_use (Task 7)", () => {
  test("redacted_thinking block is stripped from assistant message (Branch 2, no tool calls)", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Think hard." },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "EncryptedBinaryData==" },
            { type: "text", text: "My considered answer." },
          ],
        },
        { role: "user", content: "Follow up." },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    // Content must contain the text but NOT the redacted data
    expect(assistantMsg?.content).toContain("My considered answer.")
    expect(assistantMsg?.content).not.toContain("EncryptedBinaryData==")
  })

  test("server_tool_use block is serialized in assistant message with tool calls (Branch 1)", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Do something." },
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "test" } },
            { type: "text", text: "Let me also call a tool." },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    // Branch 1: has tool_use, so content is the text + server_tool_use serialized
    expect(assistantMsg?.content).toContain("Let me also call a tool.")
    expect(assistantMsg?.content).toContain("[Server tool use:")
    expect(assistantMsg?.tool_calls).toHaveLength(1)
    expect(assistantMsg?.tool_calls?.[0].function.name).toBe("Bash")
  })
})

describe("strict field forwarding (Task 3)", () => {
  test("should forward strict:true from custom tool definitions to OpenAI", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      tools: [
        {
          name: "getWeather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
          strict: true,
        },
      ],
    }
    const result = translateToOpenAI(anthropicPayload)
    expect(result.tools?.[0].function.strict).toBe(true)
  })

  test("should not add strict field when not provided", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      tools: [
        {
          name: "getWeather",
          description: "Get weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
    }
    const result = translateToOpenAI(anthropicPayload)
    expect(result.tools?.[0].function.strict).toBeUndefined()
  })
})

function getTranslatedModel(model: string): string {
  const result = translateToOpenAI({
    model,
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 10,
  })
  return result.model
}

describe("translateModelName normalization", () => {
  test("normalizes claude-sonnet-4-6 to claude-sonnet-4", () => {
    expect(getTranslatedModel("claude-sonnet-4-6")).toBe("claude-sonnet-4")
  })

  test("normalizes claude-haiku-4-5 to claude-haiku-4 (was missing before)", () => {
    expect(getTranslatedModel("claude-haiku-4-5")).toBe("claude-haiku-4")
  })

  test("normalizes claude-opus-4-6 to claude-opus-4", () => {
    expect(getTranslatedModel("claude-opus-4-6")).toBe("claude-opus-4")
  })

  test("does NOT change claude-sonnet-3-5 (stable 3.x name)", () => {
    expect(getTranslatedModel("claude-sonnet-3-5")).toBe("claude-sonnet-3-5")
  })

  test("does NOT change claude-haiku-3-5 (stable 3.x name)", () => {
    expect(getTranslatedModel("claude-haiku-3-5")).toBe("claude-haiku-3-5")
  })

  test("normalizes long versioned names like claude-sonnet-4-6-20251231", () => {
    expect(getTranslatedModel("claude-sonnet-4-6-20251231")).toBe(
      "claude-sonnet-4",
    )
  })

  test("does NOT change non-claude models", () => {
    expect(getTranslatedModel("gpt-4o")).toBe("gpt-4o")
    expect(getTranslatedModel("grok-2")).toBe("grok-2")
  })
})

describe("OpenAI Chat Completion v1 Request Payload Validation with Zod", () => {
  test("should return true for a minimal valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test("should return true for a comprehensive valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather like in Boston?" },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
      n: 1,
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test('should return false if the "model" field is missing', () => {
    const invalidPayload = {
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" field is missing', () => {
    const invalidPayload = {
      model: "gpt-4o",
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" array is empty', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "model" is not a string', () => {
    const invalidPayload = {
      model: 12345,
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "messages" is not an array', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: { role: "user", content: "Hello!" },
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing a "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing "content"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user" }],
    }
    // Note: Zod considers 'undefined' as missing, so this will fail as expected.
    const result = chatCompletionRequestSchema.safeParse(invalidPayload)
    expect(result.success).toBe(false)
  })

  test('should return false if a message has an invalid "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "customer", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false if an optional field has an incorrect type", () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for a completely empty object", () => {
    const invalidPayload = {}
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for null or non-object payloads", () => {
    expect(isValidChatCompletionRequest(null)).toBe(false)
    expect(isValidChatCompletionRequest(undefined)).toBe(false)
    expect(isValidChatCompletionRequest("a string")).toBe(false)
    expect(isValidChatCompletionRequest(123)).toBe(false)
  })
})
