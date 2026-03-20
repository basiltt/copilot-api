import { describe, test, expect, spyOn, afterEach, mock } from "bun:test"

import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import * as stateModule from "~/lib/state"
import * as createChatCompletionsModule from "~/services/copilot/create-chat-completions"
import { webSearchInterceptor } from "~/services/web-search/interceptor"
import { appendWebSearchInstruction } from "~/services/web-search/system-prompt"

function makeCopilotResponse(
  finishReason: "stop" | "tool_calls",
  toolCalls?: Array<{ id: string; name: string; arguments: string }>,
): ChatCompletionResponse {
  return {
    id: "resp-1",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: finishReason,
        message: {
          role: "assistant",
          content: finishReason === "stop" ? "Here is my answer." : null,
          tool_calls: toolCalls?.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
      },
    ],
  }
}

function makePayload(stream = false): ChatCompletionsPayload {
  return {
    model: "gpt-4o",
    stream,
    messages: [{ role: "user", content: "What is the weather today?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ],
  }
}

describe("webSearchInterceptor — streaming preservation", () => {
  afterEach(() => {
    mock.restore()
  })

  test("re-issues with stream:true when Copilot returns stop (no tool call)", async () => {
    const stopResponse = makeCopilotResponse("stop")
    const streamingPayload: ChatCompletionsPayload = makePayload(true)
    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(stopResponse) // first pass: non-streaming inspection
      .mockResolvedValueOnce(stopResponse) // streaming re-issue: no tool call, returned to caller

    await webSearchInterceptor(streamingPayload)

    // Interceptor must have made exactly 2 calls
    expect(createSpy).toHaveBeenCalledTimes(2)

    // Second call must NOT include the web_search tool
    const secondCallArg = createSpy.mock.calls[1][0]
    expect(secondCallArg.stream).toBe(true)
    expect(
      secondCallArg.tools?.some((t) => t.function.name === "web_search"),
    ).toBe(false)
  })

  test("does NOT re-issue when stream is false and Copilot returns stop", async () => {
    const stopResponse = makeCopilotResponse("stop")
    const nonStreamingPayload: ChatCompletionsPayload = makePayload(false)
    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    ).mockResolvedValue(stopResponse)

    await webSearchInterceptor(nonStreamingPayload)

    // Only 1 call — non-streaming first pass returned directly, no re-issue
    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  test("re-issues with stream:true when Copilot calls a different tool (not web_search)", async () => {
    const otherToolResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-1", name: "bash", arguments: '{"command":"ls"}' },
    ])
    const streamingPayload: ChatCompletionsPayload = makePayload(true)
    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(otherToolResponse)
      .mockResolvedValueOnce(otherToolResponse)

    await webSearchInterceptor(streamingPayload)

    expect(createSpy).toHaveBeenCalledTimes(2)
    const secondCallArg = createSpy.mock.calls[1][0]
    expect(secondCallArg.stream).toBe(true)
    expect(
      secondCallArg.tools?.some((t) => t.function.name === "web_search"),
    ).toBe(false)
  })
})

describe("isWebSearchEnabled — Tavily", () => {
  test("returns false when neither key is set", () => {
    const originalBrave = stateModule.state.braveApiKey
    const originalTavily = stateModule.state.tavilyApiKey
    stateModule.state.braveApiKey = undefined
    stateModule.state.tavilyApiKey = undefined
    try {
      expect(stateModule.isWebSearchEnabled()).toBe(false)
    } finally {
      stateModule.state.braveApiKey = originalBrave
      stateModule.state.tavilyApiKey = originalTavily
    }
  })

  test("returns true when tavilyApiKey is set", () => {
    const originalBrave = stateModule.state.braveApiKey
    const originalTavily = stateModule.state.tavilyApiKey
    stateModule.state.braveApiKey = undefined
    stateModule.state.tavilyApiKey = "test-key"
    try {
      expect(stateModule.isWebSearchEnabled()).toBe(true)
    } finally {
      stateModule.state.braveApiKey = originalBrave
      stateModule.state.tavilyApiKey = originalTavily
    }
  })

  test("returns true when both keys are set", () => {
    const originalBrave = stateModule.state.braveApiKey
    const originalTavily = stateModule.state.tavilyApiKey
    stateModule.state.braveApiKey = "brave-key"
    stateModule.state.tavilyApiKey = "tavily-key"
    try {
      expect(stateModule.isWebSearchEnabled()).toBe(true)
    } finally {
      stateModule.state.braveApiKey = originalBrave
      stateModule.state.tavilyApiKey = originalTavily
    }
  })
})

describe("appendWebSearchInstruction", () => {
  test("appends instruction to string system prompt", () => {
    const result = appendWebSearchInstruction("You are a helpful assistant.")
    expect(typeof result).toBe("string")
    expect(result as string).toContain("You are a helpful assistant.")
    expect(result as string).toContain("web_search")
  })

  test("appends instruction to last text block in array system prompt", () => {
    const system = [
      { type: "text" as const, text: "First block." },
      { type: "text" as const, text: "Second block." },
    ]
    const result = appendWebSearchInstruction(system)
    expect(Array.isArray(result)).toBe(true)
    const blocks = result as typeof system
    expect(blocks[0].text).toBe("First block.")
    expect(blocks[1].text).toContain("Second block.")
    expect(blocks[1].text).toContain("web_search")
  })

  test("adds new text block when array has no text blocks", () => {
    const system = [{ type: "tool_result" as const, text: "some tool result" }]
    const result = appendWebSearchInstruction(
      system as unknown as Parameters<typeof appendWebSearchInstruction>[0],
    )
    expect(Array.isArray(result)).toBe(true)
    const blocks = result as Array<{ type: string; text: string }>
    expect(blocks).toHaveLength(2)
    expect(blocks[1].type).toBe("text")
    expect(blocks[1].text).toContain("web_search")
  })

  test("returns instruction string when system is undefined", () => {
    const result = appendWebSearchInstruction(undefined)
    expect(typeof result).toBe("string")
    expect(result as string).toContain("web_search")
  })
})
