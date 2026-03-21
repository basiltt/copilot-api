import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "./create-chat-completions"
import type { Model } from "./get-models"

import {
  translateToResponsesPayload,
  translateFromResponsesResponse,
  translateFromResponsesStream,
  requiresResponsesApi,
} from "./responses-translation"

// ─── requiresResponsesApi ──────────────────────────────────────────────────

describe("requiresResponsesApi", () => {
  test("returns true when model only supports /responses", () => {
    const model = {
      supported_endpoints: ["/responses"],
    } as Partial<Model> as Model
    expect(requiresResponsesApi(model)).toBe(true)
  })

  test("returns false when model supports /chat/completions", () => {
    const model = {
      supported_endpoints: ["/chat/completions"],
    } as Partial<Model> as Model
    expect(requiresResponsesApi(model)).toBe(false)
  })

  test("returns false when model has no supported_endpoints", () => {
    const model = {} as Model
    expect(requiresResponsesApi(model)).toBe(false)
  })

  test("returns false when model supports both endpoints", () => {
    const model = {
      supported_endpoints: ["/chat/completions", "/responses"],
    } as Partial<Model> as Model
    expect(requiresResponsesApi(model)).toBe(false)
  })
})

// ─── translateToResponsesPayload ──────────────────────────────────────────

describe("translateToResponsesPayload", () => {
  test("maps messages to input", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
    }
    const result = translateToResponsesPayload(payload)
    expect(result.input).toEqual([{ role: "user", content: "Hello" }])
  })

  test("extracts system message as top-level instructions", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
    }
    const result = translateToResponsesPayload(payload)
    expect(result.instructions).toBe("You are helpful")
    expect(result.input).toEqual([{ role: "user", content: "Hello" }])
  })

  test("maps max_tokens to max_output_tokens", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1000,
    }
    const result = translateToResponsesPayload(payload)
    expect(result.max_output_tokens).toBe(1000)
    expect(result).not.toHaveProperty("max_tokens")
  })

  test("maps response_format to text.format", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hi" }],
      response_format: { type: "json_object" },
    }
    const result = translateToResponsesPayload(payload)
    expect(result.text).toEqual({ format: { type: "json_object" } })
  })

  test("passes through tools unchanged", () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ]
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hi" }],
      tools,
    }
    const result = translateToResponsesPayload(payload)
    expect(result.tools).toEqual(tools)
  })

  test("passes through tool_choice unchanged", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: "auto",
    }
    const result = translateToResponsesPayload(payload)
    expect(result.tool_choice).toBe("auto")
  })

  test("passes through stream flag", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    }
    const result = translateToResponsesPayload(payload)
    expect(result.stream).toBe(true)
  })

  test("omits null/undefined optional fields", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: null,
      temperature: null,
      response_format: null,
    }
    const result = translateToResponsesPayload(payload)
    expect(result).not.toHaveProperty("max_output_tokens")
    expect(result).not.toHaveProperty("temperature")
    expect(result).not.toHaveProperty("text")
  })
})

// ─── translateFromResponsesResponse ───────────────────────────────────────

describe("translateFromResponsesResponse", () => {
  test("translates a simple text response to chat completion shape", () => {
    const responsesReply = {
      id: "resp_abc123",
      model: "gpt-5.4",
      output: [
        {
          type: "message" as const,
          role: "assistant" as const,
          content: [{ type: "output_text", text: "Hello there!" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }
    const result = translateFromResponsesResponse(responsesReply)
    expect(result.id).toBe("resp_abc123")
    expect(result.object).toBe("chat.completion")
    expect(result.model).toBe("gpt-5.4")
    expect(result.choices).toHaveLength(1)
    expect(result.choices[0].message.role).toBe("assistant")
    expect(result.choices[0].message.content).toBe("Hello there!")
    expect(result.choices[0].finish_reason).toBe("stop")
    expect(result.usage?.prompt_tokens).toBe(10)
    expect(result.usage?.completion_tokens).toBe(5)
  })

  test("translates function_call output to tool_calls", () => {
    const responsesReply = {
      id: "resp_tool",
      model: "gpt-5.4",
      output: [
        {
          type: "function_call" as const,
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"London"}',
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }
    const result = translateFromResponsesResponse(responsesReply)
    const toolCalls = result.choices[0].message.tool_calls ?? []
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"London"}' },
    })
    expect(result.choices[0].finish_reason).toBe("tool_calls")
  })

  test("handles mixed text + function_call output", () => {
    const responsesReply = {
      id: "resp_mix",
      model: "gpt-5.4",
      output: [
        {
          type: "message" as const,
          role: "assistant" as const,
          content: [{ type: "output_text", text: "Let me check." }],
        },
        {
          type: "function_call" as const,
          call_id: "call_2",
          name: "get_weather",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 },
    }
    const result = translateFromResponsesResponse(responsesReply)
    expect(result.choices[0].message.content).toBe("Let me check.")
    expect(result.choices[0].message.tool_calls).toHaveLength(1)
    expect(result.choices[0].finish_reason).toBe("tool_calls")
  })

  test("sets finish_reason to stop when no tool calls", () => {
    const responsesReply = {
      id: "resp_stop",
      model: "gpt-5.4",
      output: [
        {
          type: "message" as const,
          role: "assistant" as const,
          content: [{ type: "output_text", text: "Done." }],
        },
      ],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }
    const result = translateFromResponsesResponse(responsesReply)
    expect(result.choices[0].finish_reason).toBe("stop")
  })
})

// ─── translateFromResponsesStream ─────────────────────────────────────────

describe("translateFromResponsesStream", () => {
  test("translates output_text delta event to SSE chunk", () => {
    const event = {
      type: "response.output_text.delta",
      delta: "Hello",
      item_id: "item_1",
      output_index: 0,
      content_index: 0,
    }
    const chunk = translateFromResponsesStream(event, "resp_xyz", "gpt-5.4")
    expect(chunk).not.toBeNull()
    if (!chunk) throw new Error("chunk is null")
    const parsed = JSON.parse(chunk.data as string) as {
      id: string
      object: string
      model: string
      choices: Array<{
        delta: { content?: string }
        finish_reason: string | null
      }>
    }
    expect(parsed.id).toBe("resp_xyz")
    expect(parsed.object).toBe("chat.completion.chunk")
    expect(parsed.model).toBe("gpt-5.4")
    expect(parsed.choices[0].delta.content).toBe("Hello")
    expect(parsed.choices[0].finish_reason).toBeNull()
  })

  test("translates response.completed event to final [DONE] SSE", () => {
    const event = { type: "response.completed", response: { id: "resp_xyz" } }
    const chunk = translateFromResponsesStream(event, "resp_xyz", "gpt-5.4")
    expect(chunk).not.toBeNull()
    if (!chunk) throw new Error("chunk is null")
    expect(chunk.data).toBe("[DONE]")
  })

  test("translates response.output_text.done event to finish_reason stop chunk", () => {
    const event = {
      type: "response.output_text.done",
      text: "full text",
      item_id: "item_1",
      output_index: 0,
      content_index: 0,
    }
    const chunk = translateFromResponsesStream(event, "resp_xyz", "gpt-5.4")
    expect(chunk).not.toBeNull()
    if (!chunk) throw new Error("chunk is null")
    const parsed = JSON.parse(chunk.data as string) as {
      choices: Array<{ delta: Record<string, unknown>; finish_reason: string }>
    }
    expect(parsed.choices[0].delta).toEqual({})
    expect(parsed.choices[0].finish_reason).toBe("stop")
  })

  test("translates function_call delta event to tool_calls delta chunk", () => {
    const event = {
      type: "response.function_call_arguments.delta",
      delta: '{"city":',
      item_id: "call_1",
      output_index: 0,
    }
    const chunk = translateFromResponsesStream(event, "resp_xyz", "gpt-5.4")
    expect(chunk).not.toBeNull()
    if (!chunk) throw new Error("chunk is null")
    const parsed = JSON.parse(chunk.data as string) as {
      choices: Array<{
        delta: { tool_calls: Array<{ function: { arguments: string } }> }
        finish_reason: string | null
      }>
    }
    expect(parsed.choices[0].delta.tool_calls[0].function.arguments).toBe(
      '{"city":',
    )
  })

  test("returns null for unrecognised event types", () => {
    const event = { type: "response.created", response: {} }
    const chunk = translateFromResponsesStream(event, "resp_xyz", "gpt-5.4")
    expect(chunk).toBeNull()
  })
})
