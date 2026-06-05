/* eslint-disable max-lines */
import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "~/routes/messages/anthropic-types"
import { isEmptyNonStreamingResponse } from "~/routes/messages/handler"
import { translateToAnthropic } from "~/routes/messages/non-stream-translation"
import {
  flushDeferredFinish,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/stream-translation"
import {
  createToolNameMapFromAnthropicPayload,
  toOpenAIToolName,
} from "~/routes/messages/tool-name-mapping"

const LONG_MCP_TOOL_NAME =
  "mcp__plugin_chrome-devtools-mcp_chrome-devtools__get_console_message"

const anthropicUsageSchema = z.object({
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
})

const anthropicContentBlockTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
})

const anthropicContentBlockToolUseSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.any()),
})

const anthropicMessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.union([
      anthropicContentBlockTextSchema,
      anthropicContentBlockToolUseSchema,
    ]),
  ),
  model: z.string(),
  stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]),
  stop_sequence: z.string().nullable(),
  usage: anthropicUsageSchema,
})

/**
 * Validates if a response payload conforms to the Anthropic Message shape.
 * @param payload The response payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidAnthropicResponse(payload: unknown): boolean {
  return anthropicMessageResponseSchema.safeParse(payload).success
}

const anthropicStreamEventSchema = z.looseObject({
  type: z.enum([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]),
})

function isValidAnthropicStreamEvent(payload: unknown): boolean {
  return anthropicStreamEventSchema.safeParse(payload).success
}

// eslint-disable-next-line max-lines-per-function
describe("OpenAI to Anthropic Non-Streaming Response Translation", () => {
  test("should translate a simple text response correctly", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello! How can I help you today?",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 12,
        total_tokens: 21,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.id).toBe("msg_chatcmpl-123")
    expect(anthropicResponse.stop_reason).toBe("end_turn")
    expect(anthropicResponse.usage.input_tokens).toBe(9)
    expect(anthropicResponse.content[0].type).toBe("text")
    if (anthropicResponse.content[0].type === "text") {
      expect(anthropicResponse.content[0].text).toBe(
        "Hello! How can I help you today?",
      )
    } else {
      throw new Error("Expected text block")
    }
  })

  test("should translate a response with tool calls", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-456",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_current_weather",
                  arguments: '{"location": "Boston, MA"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content[0].type).toBe("tool_use")
    if (anthropicResponse.content[0].type === "tool_use") {
      expect(anthropicResponse.content[0].id).toBe("call_abc")
      expect(anthropicResponse.content[0].name).toBe("get_current_weather")
      expect(anthropicResponse.content[0].input).toEqual({
        location: "Boston, MA",
      })
    } else {
      throw new Error("Expected tool_use block")
    }
  })

  test("should restore long MCP tool names from aliased OpenAI tool calls", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Inspect the console output." }],
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
    }
    const toolNameMap = createToolNameMapFromAnthropicPayload(anthropicPayload)
    const aliasedToolName = toOpenAIToolName(LONG_MCP_TOOL_NAME, toolNameMap)

    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-tool-alias",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_alias",
                type: "function",
                function: {
                  name: aliasedToolName,
                  arguments: '{"request_id":"req_1"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse, toolNameMap)
    expect(anthropicResponse.content[0]?.type).toBe("tool_use")
    if (anthropicResponse.content[0]?.type === "tool_use") {
      expect(anthropicResponse.content[0].name).toBe(LONG_MCP_TOOL_NAME)
      expect(anthropicResponse.content[0].input).toEqual({
        request_id: "req_1",
      })
    } else {
      throw new Error("Expected tool_use block")
    }
  })

  test("should translate a response stopped due to length", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-789",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "This is a very long response that was cut off...",
          },
          finish_reason: "length",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2048,
        total_tokens: 2058,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)
    expect(anthropicResponse.stop_reason).toBe("max_tokens")
  })

  // Regression: a completed non-streaming message must NEVER carry
  // stop_reason: null. Anthropic clients (Claude Code, and strict SDK callers)
  // treat a null stop_reason on a non-stream response as a protocol violation.
  // Some upstream models (notably Gemini via Copilot) return a degenerate
  // payload — finish_reason null, or an empty choices array — which previously
  // mapped straight through to stop_reason: null with empty content.
  test("coerces a null upstream finish_reason to a non-null stop_reason", () => {
    const openAIResponse = {
      id: "chatcmpl-null-finish",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Partial answer." },
          // Runtime reality: Copilot can send null here even though the
          // ChoiceNonStreaming type declares finish_reason as non-null.
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    } as unknown as ChatCompletionResponse

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.stop_reason).not.toBeNull()
    expect(anthropicResponse.stop_reason).toBe("end_turn")
    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)
  })

  test("never returns stop_reason null for an empty choices array", () => {
    const openAIResponse = {
      id: "chatcmpl-no-choices",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    } as unknown as ChatCompletionResponse

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.stop_reason).not.toBeNull()
    expect(anthropicResponse.stop_reason).toBe("end_turn")
  })

  // Regression (HIGH): tool calls present but a degenerate null finish_reason.
  // The backstop must NOT label this "end_turn" — that would tell the client
  // the turn is done and the pending tool calls would never execute. It must
  // resolve to "tool_use" so the client runs the tools.
  test("tool calls with a null finish_reason resolve to tool_use, not end_turn", () => {
    const openAIResponse = {
      id: "chatcmpl-tool-null-finish",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_x",
                type: "function",
                function: {
                  name: "get_current_weather",
                  arguments: '{"location":"Boston, MA"}',
                },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    } as unknown as ChatCompletionResponse

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content[0]?.type).toBe("tool_use")
  })

  // A length-truncated tool call must stay "max_tokens" (the truncation guard
  // depends on correctedStopReason === "length"); it must NOT be masked as
  // tool_use by the coercion.
  test("tool calls with finish_reason length are not masked as tool_use", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-tool-length",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_y",
                type: "function",
                function: {
                  name: "get_current_weather",
                  // Complete JSON → not truncated → passes through as a tool call
                  arguments: '{"location":"Boston, MA"}',
                },
              },
            ],
          },
          finish_reason: "length",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 2048, total_tokens: 2078 },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)
    expect(anthropicResponse.stop_reason).toBe("max_tokens")
  })

  test("whitespace-only content with finish_reason stop is treated as empty", () => {
    const response = {
      id: "chatcmpl-whitespace",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "  \n  " },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    } as unknown as ChatCompletionResponse

    expect(isEmptyNonStreamingResponse(response)).toBe(true)
  })
})

describe("isEmptyNonStreamingResponse — degenerate upstream detection", () => {
  test("treats a null finish_reason with empty content as empty", () => {
    const response = {
      id: "chatcmpl-null-empty",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    } as unknown as ChatCompletionResponse

    expect(isEmptyNonStreamingResponse(response)).toBe(true)
  })

  test("treats an empty choices array as empty", () => {
    const response = {
      id: "chatcmpl-empty-choices",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    } as unknown as ChatCompletionResponse

    expect(isEmptyNonStreamingResponse(response)).toBe(true)
  })

  test("does not flag a normal completed response as empty", () => {
    const response: ChatCompletionResponse = {
      id: "chatcmpl-ok",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Real answer." },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }

    expect(isEmptyNonStreamingResponse(response)).toBe(false)
  })
})

// eslint-disable-next-line max-lines-per-function
describe("OpenAI to Anthropic Streaming Response Translation", () => {
  test("should translate a simple text stream correctly", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: " there" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageStopSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      thinkingBlockOpen: false,
      hasEmittedText: false,
      toolCalls: {},
      thinkingEnabled: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })
  test("should translate a stream with tool calls", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_xyz",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'ation": "Paris"}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    // Streaming translation requires state
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageStopSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      thinkingBlockOpen: false,
      hasEmittedText: false,
      toolCalls: {},
      thinkingEnabled: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    // These tests will fail until the stub is implemented
    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })

  test("restores long MCP tool names in streaming tool events", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Inspect the console output." }],
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
    }
    const toolNameMap = createToolNameMapFromAnthropicPayload(anthropicPayload)
    const aliasedToolName = toOpenAIToolName(LONG_MCP_TOOL_NAME, toolNameMap)

    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-tool-alias",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-alias",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_alias",
                  type: "function",
                  function: { name: aliasedToolName, arguments: "" },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-alias",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"request_id":"req_1"}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-alias",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageStopSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      thinkingBlockOpen: false,
      hasEmittedText: false,
      toolCalls: {},
      toolNameMap,
      thinkingEnabled: false,
    }

    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    const toolUseStart = translatedStream.find(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "tool_use",
    )

    expect(toolUseStart).toBeDefined()
    if (
      toolUseStart?.type === "content_block_start"
      && toolUseStart.content_block.type === "tool_use"
    ) {
      expect(toolUseStart.content_block.name).toBe(LONG_MCP_TOOL_NAME)
    } else {
      throw new Error("Expected tool_use content_block_start event")
    }
  })

  test("does not inject synthetic tool narration for Claude tool-call streams", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-claude-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-opus-4",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-claude-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-opus-4",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_claude",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: '{"file_path":"a.txt"}',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-claude-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-opus-4",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageStopSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      thinkingBlockOpen: false,
      hasEmittedText: false,
      toolCalls: {},
      thinkingEnabled: false,
    }

    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    const textDeltas = translatedStream.filter(
      (event) =>
        event.type === "content_block_delta"
        && event.delta.type === "text_delta",
    )
    expect(textDeltas).toHaveLength(0)

    const toolStarts = translatedStream.filter(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "tool_use",
    )
    expect(toolStarts).toHaveLength(1)
  })

  test("still injects synthetic tool narration for non-Claude tool-call streams", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-gemini-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-2.5-pro",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-gemini-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-2.5-pro",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_gemini",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: '{"file_path":"a.txt"}',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-gemini-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-2.5-pro",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageStopSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      thinkingBlockOpen: false,
      hasEmittedText: false,
      toolCalls: {},
      thinkingEnabled: false,
    }

    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    const textDeltas = translatedStream.filter(
      (event) =>
        event.type === "content_block_delta"
        && event.delta.type === "text_delta",
    )
    expect(textDeltas.length).toBeGreaterThan(0)
  })
})

function freshStreamState(): AnthropicStreamState {
  return {
    messageStartSent: false,
    messageStopSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    thinkingBlockOpen: false,
    hasEmittedText: false,
    toolCalls: {},
    thinkingEnabled: false,
  }
}

function finalStreamDelta(state: AnthropicStreamState) {
  const delta = flushDeferredFinish(state).find(
    (e) => e.type === "message_delta",
  )
  if (delta?.type !== "message_delta") {
    throw new Error("Expected a terminating message_delta")
  }
  return delta
}

describe("Streaming terminating stop_reason — never null/omitted", () => {
  // Regression: a streamed tool call whose finish chunk reports a non-standard
  // finish_reason (Copilot runtime can violate its own type) must still defer a
  // "tool_calls" reason and terminate as "tool_use" — not omit stop_reason,
  // which would make Claude Code skip executing the tool.
  test("tool-call stream with a non-standard finish_reason terminates as tool_use", () => {
    const state = freshStreamState()
    const stream: Array<ChatCompletionChunk> = [
      {
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"loc":"NYC"}' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        // Non-standard finish_reason string — runtime type violation.
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "STOP" as never,
            logprobs: null,
          },
        ],
      },
    ]
    for (const chunk of stream) translateChunkToAnthropicEvents(chunk, state)

    const delta = finalStreamDelta(state)
    expect(delta.delta.stop_reason).toBe("tool_use")
  })

  // A tool-call stream that finishes with the normal "stop" mismatch must also
  // terminate as tool_use (existing Gemini-correction behavior, now broadened).
  test("tool-call stream finishing with stop terminates as tool_use", () => {
    const state = freshStreamState()
    translateChunkToAnthropicEvents(
      {
        id: "c2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_b",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"loc":"LA"}' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      state,
    )
    translateChunkToAnthropicEvents(
      {
        id: "c2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
      state,
    )

    expect(finalStreamDelta(state).delta.stop_reason).toBe("tool_use")
  })

  // A plain text stream finishing with a non-standard finish_reason and no tool
  // calls must terminate as end_turn (not an omitted stop_reason).
  test("text stream with a non-standard finish_reason terminates as end_turn", () => {
    const state = freshStreamState()
    translateChunkToAnthropicEvents(
      {
        id: "c3",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      state,
    )
    translateChunkToAnthropicEvents(
      {
        id: "c3",
        object: "chat.completion.chunk",
        created: 1,
        model: "gemini-2.5-pro",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "DONE" as never,
            logprobs: null,
          },
        ],
      },
      state,
    )

    expect(finalStreamDelta(state).delta.stop_reason).toBe("end_turn")
  })

  // A normal text stream still terminates correctly as end_turn.
  test("normal text stream terminates as end_turn", () => {
    const state = freshStreamState()
    translateChunkToAnthropicEvents(
      {
        id: "c4",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: { content: "Hi" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      state,
    )
    translateChunkToAnthropicEvents(
      {
        id: "c4",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
      state,
    )

    expect(finalStreamDelta(state).delta.stop_reason).toBe("end_turn")
  })
})
