/* eslint-disable max-lines */
import {
  describe,
  test,
  expect,
  spyOn,
  beforeEach,
  afterEach,
  mock,
} from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import * as stateModule from "~/lib/state"
import { state } from "~/lib/state"
import {
  isTypedTool,
  type AnthropicTool,
} from "~/routes/messages/anthropic-types"
import {
  detectWebSearchIntent,
  stripWebSearchTypedTools,
} from "~/routes/messages/web-search-detection"
import * as createChatCompletionsModule from "~/services/copilot/create-chat-completions"
import * as braveModule from "~/services/web-search/brave"
import {
  webSearchInterceptor,
  prepareWebSearchPayload,
} from "~/services/web-search/interceptor"
import * as tavilyModule from "~/services/web-search/tavily"
import {
  WEB_SEARCH_TOOL_NAMES,
  WEB_SEARCH_FUNCTION_TOOL,
} from "~/services/web-search/tool-definition"
import { BraveSearchError, WebSearchError } from "~/services/web-search/types"

describe("WEB_SEARCH_TOOL_NAMES", () => {
  test("contains web_search", () => {
    expect(WEB_SEARCH_TOOL_NAMES.has("web_search")).toBe(true)
  })

  test("contains internet_research", () => {
    expect(WEB_SEARCH_TOOL_NAMES.has("internet_research")).toBe(true)
  })

  test("does NOT contain search (too generic)", () => {
    expect(WEB_SEARCH_TOOL_NAMES.has("search")).toBe(false)
  })
})

describe("Typed tool detection guard", () => {
  test("typed tool named web_search — no input_schema — matches", () => {
    const tool: AnthropicTool = {
      type: "web_search_20260101",
      name: "web_search",
    }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(true)
  })

  test("typed tool named internet_research matches", () => {
    const tool: AnthropicTool = {
      type: "internet_research_20260101",
      name: "internet_research",
    }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(true)
  })

  test("future versioned type — detected by name, not type string (different version)", () => {
    const tool: AnthropicTool = {
      type: "web_search_20260601",
      name: "web_search",
    }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(true)
  })

  test("custom tool named web_search WITH input_schema — NOT matched", () => {
    const tool: AnthropicTool = {
      name: "web_search",
      input_schema: { type: "object", properties: {} },
    }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(
      false,
    )
  })

  test("custom tool named search WITH input_schema — NOT matched", () => {
    const tool: AnthropicTool = {
      name: "search",
      input_schema: { type: "object", properties: {} },
    }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(
      false,
    )
  })
})

describe("WEB_SEARCH_FUNCTION_TOOL", () => {
  test("type is function", () => {
    expect(WEB_SEARCH_FUNCTION_TOOL.type).toBe("function")
  })

  test("function name is web_search", () => {
    expect(WEB_SEARCH_FUNCTION_TOOL.function.name).toBe("web_search")
  })

  test("has parameters with query property", () => {
    const params = WEB_SEARCH_FUNCTION_TOOL.function.parameters as {
      properties: { query: unknown }
      required: Array<string>
    }
    expect(params.properties.query).toBeDefined()
    expect(params.required).toContain("query")
  })
})

describe("searchBrave — result formatting", () => {
  afterEach(() => {
    mock.restore()
  })

  test("formats top 5 results as Array<BraveSearchResult>", async () => {
    const mockResponse = {
      web: {
        results: [
          {
            title: "Result 1",
            url: "https://example.com/1",
            description: "Desc 1",
          },
          {
            title: "Result 2",
            url: "https://example.com/2",
            description: "Desc 2",
          },
          {
            title: "Result 3",
            url: "https://example.com/3",
            description: "Desc 3",
          },
          {
            title: "Result 4",
            url: "https://example.com/4",
            description: "Desc 4",
          },
          {
            title: "Result 5",
            url: "https://example.com/5",
            description: "Desc 5",
          },
        ],
      },
    }
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const results = await braveModule.searchBrave("test query", "fake-api-key")
    expect(results).toHaveLength(5)
    expect(results[0]).toEqual({
      title: "Result 1",
      url: "https://example.com/1",
      description: "Desc 1",
    })
    expect(results[4]?.url).toBe("https://example.com/5")
  })

  test("returns empty array when web.results is empty", async () => {
    const mockResponse = { web: { results: [] } }
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const results = await braveModule.searchBrave(
      "nothing here",
      "fake-api-key",
    )
    expect(results).toHaveLength(0)
  })

  test("returns empty array when web key is absent", async () => {
    const mockResponse = {}
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const results = await braveModule.searchBrave("nothing", "fake-api-key")
    expect(results).toHaveLength(0)
  })

  test("uses empty string for missing description field", async () => {
    const mockResponse = {
      web: { results: [{ title: "T", url: "https://u.com" }] },
    }
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const results = await braveModule.searchBrave("q", "fake-api-key")
    expect(results[0]?.description).toBe("")
  })
})

describe("searchBrave — error handling", () => {
  afterEach(() => {
    mock.restore()
  })

  test("throws BraveSearchError on non-200 response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Forbidden", { status: 403 }),
    )

    let threw: unknown
    try {
      await braveModule.searchBrave("query", "bad-key")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(BraveSearchError)
  })

  test("BraveSearchError reason includes status code on non-200", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Forbidden", { status: 403 }),
    )

    let threw: unknown
    try {
      await braveModule.searchBrave("query", "bad-key")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(BraveSearchError)
    expect((threw as InstanceType<typeof BraveSearchError>).reason).toContain("403")
  })

  test("throws BraveSearchError on network failure", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"))

    let threw: unknown
    try {
      await braveModule.searchBrave("query", "key")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(BraveSearchError)
  })
})

// Helper: build a minimal non-streaming ChatCompletionResponse
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

describe("webSearchInterceptor — no search path", () => {
  afterEach(() => {
    mock.restore()
  })

  test("returns response as-is when finish_reason is stop", async () => {
    const stopResponse = makeCopilotResponse("stop")
    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    ).mockResolvedValue(stopResponse)

    const result = await webSearchInterceptor(makePayload())

    expect(result).toEqual(stopResponse)
    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  test("returns response as-is when tool_calls is for a different tool", async () => {
    const otherToolResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-1", name: "bash", arguments: '{"command":"ls"}' },
    ])
    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    ).mockResolvedValue(otherToolResponse)

    const result = await webSearchInterceptor(makePayload())

    expect(result).toEqual(otherToolResponse)
    expect(createSpy).toHaveBeenCalledTimes(1)
  })
})

describe("webSearchInterceptor — search path", () => {
  beforeEach(() => {
    // The interceptor guards on state.braveApiKey before calling searchBrave.
    // Set a fake key so the guard passes and the spy is reached.
    state.braveApiKey = "test-key"
  })

  afterEach(() => {
    state.braveApiKey = undefined
    mock.restore()
  })

  test("calls Brave and makes a second Copilot call when web_search is triggered", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      {
        id: "tc-ws",
        name: "web_search",
        arguments: '{"query":"latest AI news"}',
      },
    ])
    const finalResponse = makeCopilotResponse("stop")
    const braveResults = [
      {
        title: "AI News",
        url: "https://ainews.com",
        description: "Latest AI developments",
      },
    ]

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockResolvedValue(braveResults)

    const result = await webSearchInterceptor(makePayload())

    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(result).toEqual(finalResponse)
    expect(createSpy.mock.calls[0]?.[0]?.stream).toBe(false)
  })

  test("second pass uses original stream flag", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: '{"query":"news"}' },
    ])
    const finalResponse = makeCopilotResponse("stop")

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockResolvedValue([])

    await webSearchInterceptor(makePayload(true))

    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(createSpy.mock.calls[0]?.[0]?.stream).toBe(false)
    expect(createSpy.mock.calls[1]?.[0]?.stream).toBe(true)
  })

  test("injects stub tool results for non-search tool_calls alongside web_search", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: '{"query":"q"}' },
      { id: "tc-bash", name: "bash", arguments: '{"command":"ls"}' },
    ])
    const finalResponse = makeCopilotResponse("stop")

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockResolvedValue([])

    await webSearchInterceptor(makePayload())

    const secondCallMessages = createSpy.mock.calls[1]?.[0]?.messages
    const toolMessages = secondCallMessages.filter((m) => m.role === "tool")
    expect(toolMessages).toHaveLength(2)
    const toolIds = toolMessages.map((m) => m.tool_call_id)
    expect(toolIds).toContain("tc-ws")
    expect(toolIds).toContain("tc-bash")
  })

  test("injects failure message when Brave throws BraveSearchError", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: '{"query":"q"}' },
    ])
    const finalResponse = makeCopilotResponse("stop")

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockRejectedValue(
      new BraveSearchError("HTTP 429"),
    )

    await webSearchInterceptor(makePayload())

    expect(createSpy).toHaveBeenCalledTimes(2)
    const secondCallMessages = createSpy.mock.calls[1]?.[0]?.messages
    const toolMsg = secondCallMessages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain("Web search failed")
    expect(toolMsg?.content).toContain("training data")
  })

  test("injects failure message when query JSON.parse fails", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: "INVALID_JSON" },
    ])
    const finalResponse = makeCopilotResponse("stop")

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockResolvedValue([])

    await webSearchInterceptor(makePayload())

    expect(createSpy).toHaveBeenCalledTimes(2)
    const secondCallMessages = createSpy.mock.calls[1]?.[0]?.messages
    const toolMsg = secondCallMessages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain("Web search failed")
  })

  test("second pass sets tool_choice: 'none' to prevent re-invoking web search", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: '{"query":"q"}' },
    ])
    const finalResponse = makeCopilotResponse("stop")

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockResolvedValue([])

    // Even if the original payload had a different tool_choice, second pass
    // must override with "none" to prevent the model from re-triggering search.
    const payloadWithChoice: ChatCompletionsPayload = {
      ...makePayload(),
      tool_choice: { type: "function", function: { name: "web_search" } },
    }

    await webSearchInterceptor(payloadWithChoice)

    expect(createSpy.mock.calls[1]?.[0]?.tool_choice).toBe("none")
  })
})

function makeAnthropicPayload(
  tools?: AnthropicMessagesPayload["tools"],
  lastUserContent = "Tell me about yourself",
): AnthropicMessagesPayload {
  return {
    model: "claude-opus-4",
    max_tokens: 1024,
    messages: [{ role: "user", content: lastUserContent }],
    tools,
  }
}

function makePreflightResponse(answer: "yes" | "no"): ChatCompletionResponse {
  return {
    id: "preflight-1",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: "stop",
        message: { role: "assistant", content: answer },
      },
    ],
  }
}

describe("stripWebSearchTypedTools", () => {
  test("removes typed web_search tool from tools array", () => {
    const payload = makeAnthropicPayload([
      { type: "web_search_20250305", name: "web_search" },
      {
        name: "bash",
        description: "Run bash",
        input_schema: { type: "object", properties: {}, required: [] },
      },
    ])
    const stripped = stripWebSearchTypedTools(payload)
    expect(stripped.tools).toHaveLength(1)
    expect(stripped.tools?.[0]).toMatchObject({ name: "bash" })
  })

  test("keeps non-search typed tools (e.g. bash_20250124)", () => {
    const payload = makeAnthropicPayload([
      { type: "web_search_20250305", name: "web_search" },
      { type: "bash_20250124", name: "bash" },
    ])
    const stripped = stripWebSearchTypedTools(payload)
    expect(stripped.tools).toHaveLength(1)
    expect(stripped.tools?.[0]).toMatchObject({ name: "bash" })
  })

  test("returns payload unchanged when no web search tools present", () => {
    const payload = makeAnthropicPayload([
      {
        name: "my_tool",
        description: "A tool",
        input_schema: { type: "object", properties: {} },
      },
    ])
    const stripped = stripWebSearchTypedTools(payload)
    expect(stripped.tools).toHaveLength(1)
  })

  test("does not mutate original payload", () => {
    const payload = makeAnthropicPayload([
      { type: "web_search_20250305", name: "web_search" },
    ])
    const originalToolsLength = payload.tools?.length
    stripWebSearchTypedTools(payload)
    expect(payload.tools?.length).toBe(originalToolsLength)
  })
})

describe("detectWebSearchIntent — Path 1 (typed tool)", () => {
  afterEach(() => {
    mock.restore()
  })

  test("returns true immediately when typed web_search tool present (no preflight call)", async () => {
    const payload = makeAnthropicPayload([
      { type: "web_search_20250305", name: "web_search" },
    ])

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(true)
    expect(createSpy).not.toHaveBeenCalled()
  })
})

describe("detectWebSearchIntent — Path 2 (natural language preflight)", () => {
  afterEach(() => {
    mock.restore()
  })

  test("returns true when preflight responds yes", async () => {
    const payload = makeAnthropicPayload(
      [
        {
          name: "web_search",
          description: "Search",
          input_schema: {
            type: "object",
            properties: { query: {} },
            required: ["query"],
          },
        },
      ],
      "What happened in the news today?",
    )

    spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    ).mockResolvedValue(makePreflightResponse("yes"))

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(true)
  })

  test("returns false when preflight responds no", async () => {
    const payload = makeAnthropicPayload(
      [
        {
          name: "web_search",
          description: "Search",
          input_schema: {
            type: "object",
            properties: { query: {} },
            required: ["query"],
          },
        },
      ],
      "Write me a poem",
    )

    spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    ).mockResolvedValue(makePreflightResponse("no"))

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(false)
  })

  test("returns false (and logs warning) when preflight call throws", async () => {
    const payload = makeAnthropicPayload(
      [
        {
          name: "web_search",
          description: "Search",
          input_schema: {
            type: "object",
            properties: { query: {} },
            required: ["query"],
          },
        },
      ],
      "Search for something",
    )

    spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    ).mockRejectedValue(new Error("network failure"))

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(false)
  })

  test("returns false immediately when payload has no tools (skips preflight)", async () => {
    const payload = makeAnthropicPayload(undefined, "What is the news today?")

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(false)
    expect(createSpy).not.toHaveBeenCalled()
  })

  test("returns false immediately when tools array is empty (skips preflight)", async () => {
    const payload = makeAnthropicPayload([], "What is the news today?")

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(false)
    expect(createSpy).not.toHaveBeenCalled()
  })
})

describe("prepareWebSearchPayload", () => {
  test("appends WEB_SEARCH_FUNCTION_TOOL to tools array", () => {
    const payload = makePayload()
    const prepared = prepareWebSearchPayload(payload)
    const names = prepared.tools?.map((t) => t.function.name) ?? []
    expect(names).toContain(WEB_SEARCH_FUNCTION_TOOL.function.name)
  })

  test("does not mutate original payload", () => {
    const payload = makePayload()
    const originalLength = payload.tools?.length ?? 0
    prepareWebSearchPayload(payload)
    expect(payload.tools?.length).toBe(originalLength)
  })

  test("works when payload has no tools", () => {
    const payload: ChatCompletionsPayload = { ...makePayload(), tools: undefined }
    const prepared = prepareWebSearchPayload(payload)
    expect(prepared.tools).toHaveLength(1)
    expect(prepared.tools?.[0]?.function.name).toBe(WEB_SEARCH_FUNCTION_TOOL.function.name)
  })
})

describe("detectWebSearchIntent — Path 2 scoping", () => {
  afterEach(() => {
    mock.restore()
  })

  test("skips preflight when tools are all non-web-search (e.g. bash)", async () => {
    // A request with Bash/editor tools but no web-search-named tools should
    // never fire a preflight call (protects Claude Code sessions from overhead).
    const payload = makeAnthropicPayload(
      [
        {
          name: "bash",
          description: "Run bash commands",
          input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        },
      ],
      "What is the current stock price of Apple?",
    )

    const createSpy = spyOn(createChatCompletionsModule, "createChatCompletions")

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(false)
    expect(createSpy).not.toHaveBeenCalled()
  })

  test("fires preflight when a custom web_search tool is present", async () => {
    const payload = makeAnthropicPayload(
      [
        {
          name: "web_search",
          description: "Search the web",
          input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      ],
      "What is the current stock price of Apple?",
    )

    spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValue(makePreflightResponse("yes"))

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(true)
  })
})

describe("isWebSearchEnabled", () => {
  test("returns false when braveApiKey is not set", () => {
    const originalKey = stateModule.state.braveApiKey
    stateModule.state.braveApiKey = undefined
    try {
      expect(stateModule.isWebSearchEnabled()).toBe(false)
    } finally {
      stateModule.state.braveApiKey = originalKey
    }
  })

  test("returns true when braveApiKey is set", () => {
    const originalKey = stateModule.state.braveApiKey
    stateModule.state.braveApiKey = "test-key"
    try {
      expect(stateModule.isWebSearchEnabled()).toBe(true)
    } finally {
      stateModule.state.braveApiKey = originalKey
    }
  })
})

describe("searchTavily — result formatting", () => {
  afterEach(() => {
    mock.restore()
  })

  test("formats results mapping content to description", async () => {
    const mockResponse = {
      results: [
        { title: "T1", url: "https://t.com/1", content: "C1" },
        { title: "T2", url: "https://t.com/2", content: "C2" },
      ],
    }
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const results = await tavilyModule.searchTavily("test query", "fake-key")
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: "T1",
      url: "https://t.com/1",
      description: "C1",
    })
    expect(results[1]?.url).toBe("https://t.com/2")
  })

  test("returns empty array when results is empty", async () => {
    const mockResponse = { results: [] }
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const results = await tavilyModule.searchTavily("nothing here", "fake-key")
    expect(results).toHaveLength(0)
  })

  test("returns empty array when results key is absent", async () => {
    const mockResponse = {}
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    )

    const results = await tavilyModule.searchTavily("nothing", "fake-key")
    expect(results).toHaveLength(0)
  })

  test("sends Authorization: Bearer header", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    )

    await tavilyModule.searchTavily("q", "my-secret-key")

    expect(fetchSpy).toHaveBeenCalled()
    // Take the most recent call — it's the one our searchTavily just made
    const lastCall = fetchSpy.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const headers = lastCall?.[1]?.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer my-secret-key")
  })
})

describe("searchTavily — error handling", () => {
  afterEach(() => {
    mock.restore()
  })

  test("throws WebSearchError on non-200 response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    )

    let threw: unknown
    try {
      await tavilyModule.searchTavily("q", "bad-key")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(WebSearchError)
  })

  test("WebSearchError reason includes status code on non-200", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    )

    let threw: unknown
    try {
      await tavilyModule.searchTavily("q", "bad-key")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(WebSearchError)
    expect((threw as WebSearchError).reason).toContain("401")
  })

  test("throws WebSearchError on network failure", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"))

    let threw: unknown
    try {
      await tavilyModule.searchTavily("q", "key")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(WebSearchError)
  })

  test("throws WebSearchError with 'request timed out' reason on AbortError", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    )

    let threw: unknown
    try {
      await tavilyModule.searchTavily("q", "key")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(WebSearchError)
    expect((threw as WebSearchError).reason).toBe("request timed out")
  })
})

describe("webSearchInterceptor — Tavily search path", () => {
  beforeEach(() => {
    state.tavilyApiKey = "tavily-test-key"
    state.braveApiKey = undefined
  })

  afterEach(() => {
    state.tavilyApiKey = undefined
    mock.restore()
  })

  test("calls Tavily and makes a second Copilot call when web_search is triggered", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      {
        id: "tc-ws",
        name: "web_search",
        arguments: '{"query":"latest AI news"}',
      },
    ])
    const finalResponse = makeCopilotResponse("stop")
    const tavilyResults = [
      {
        title: "AI News",
        url: "https://ainews.com",
        description: "Latest AI developments",
      },
    ]

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(tavilyModule, "searchTavily").mockResolvedValue(tavilyResults)

    const result = await webSearchInterceptor(makePayload())

    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(result).toEqual(finalResponse)
    expect(createSpy.mock.calls[0]?.[0]?.stream).toBe(false)
  })

  test("prefers Tavily over Brave when both keys are set", async () => {
    state.tavilyApiKey = "tavily-key"
    state.braveApiKey = "brave-key"

    const firstResponse = makeCopilotResponse("tool_calls", [
      {
        id: "tc-ws",
        name: "web_search",
        arguments: '{"query":"latest news"}',
      },
    ])
    const finalResponse = makeCopilotResponse("stop")

    spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    const tavilySpy = spyOn(tavilyModule, "searchTavily").mockResolvedValue([])
    const braveSpy = spyOn(braveModule, "searchBrave").mockResolvedValue([])

    await webSearchInterceptor(makePayload())

    expect(tavilySpy).toHaveBeenCalled()
    expect(braveSpy).not.toHaveBeenCalled()

    state.braveApiKey = undefined
  })

  test("injects failure message when Tavily throws WebSearchError", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: '{"query":"q"}' },
    ])
    const finalResponse = makeCopilotResponse("stop")

    const createSpy = spyOn(
      createChatCompletionsModule,
      "createChatCompletions",
    )
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(tavilyModule, "searchTavily").mockRejectedValue(
      new WebSearchError("HTTP 429"),
    )

    await webSearchInterceptor(makePayload())

    expect(createSpy).toHaveBeenCalledTimes(2)
    const secondCallMessages = createSpy.mock.calls[1]?.[0]?.messages
    const toolMsg = secondCallMessages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain("Web search failed")
    expect(toolMsg?.content).toContain("training data")
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
