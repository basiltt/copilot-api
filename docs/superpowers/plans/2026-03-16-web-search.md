# Web Search Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add transparent server-side web search via Brave Search API — when a client requests web search (typed tool or natural language), the proxy performs the search itself and injects results before forwarding to Copilot, replicating the real Anthropic API's server-side behavior.

**Architecture:** Detection runs on the raw Anthropic payload (before `translateToOpenAI`) using `isTypedTool` + `WEB_SEARCH_TOOL_NAMES`. A new `web-search-detection.ts` module handles typed-tool and natural-language detection; a new `interceptor.ts` runs the non-streaming first pass + Brave call + second pass; `brave.ts` is a pure HTTP client for the Brave Search API.

**Tech Stack:** TypeScript, Bun, `bun:test`, `fetch` (with `AbortController` for timeouts), `fetch-event-stream` (already in use), `consola` for logging.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/services/web-search/types.ts` | `BraveSearchResult`, `BraveSearchError` types only |
| Create | `src/services/web-search/tool-definition.ts` | `WEB_SEARCH_TOOL_NAMES` set + `WEB_SEARCH_FUNCTION_TOOL` constant |
| Create | `src/services/web-search/brave.ts` | `searchBrave()` — HTTP call to Brave Search API, returns results or throws |
| Create | `src/services/web-search/interceptor.ts` | `webSearchInterceptor()` — tool-call loop (first pass → search → second pass) |
| Create | `src/routes/messages/web-search-detection.ts` | `detectWebSearchIntent()` + `stripWebSearchTypedTools()` — Anthropic-layer detection |
| Modify | `src/lib/state.ts` | Add `braveApiKey?: string` + `isWebSearchEnabled()` |
| Modify | `src/start.ts` | Read `BRAVE_API_KEY` env var, store in state, log startup message |
| Modify | `src/routes/messages/handler.ts` | Restructure to branch on web search intent; move `manualApprove` before translation |
| Create | `tests/web-search.test.ts` | All web search tests (detection, interceptor, Brave client) |

---

## Chunk 1: Types, Constants, and Brave Client

### Task 1: Shared types

**Files:**
- Create: `src/services/web-search/types.ts`

- [ ] **Step 1: Create `src/services/web-search/types.ts`**

```typescript
export interface BraveSearchResult {
  title: string
  url: string
  description: string
}

export class BraveSearchError extends Error {
  constructor(public readonly reason: string) {
    super(`Brave search failed: ${reason}`)
    this.name = "BraveSearchError"
  }
}
```

- [ ] **Step 2: Run typecheck to verify no errors**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/web-search/types.ts
SKIP_SIMPLE_GIT_HOOKS=1 git commit -m "feat: add BraveSearchResult and BraveSearchError types"
```

---

### Task 2: Tool name set and injected function tool constant

**Files:**
- Create: `src/services/web-search/tool-definition.ts`
- Create: `tests/web-search.test.ts` (first tests)

The `Tool` type is imported from `~/services/copilot/create-chat-completions` — that is the correct import path (not a local alias for something else). The `parameters` field is required (not optional) on `Tool`.

- [ ] **Step 1: Write the failing tests**

Create `tests/web-search.test.ts`:

```typescript
import { describe, test, expect, spyOn, afterEach, mock } from "bun:test"

import { isTypedTool } from "~/routes/messages/anthropic-types"
import type { AnthropicTool, AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import {
  WEB_SEARCH_TOOL_NAMES,
  WEB_SEARCH_FUNCTION_TOOL,
} from "~/services/web-search/tool-definition"

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
    const tool: AnthropicTool = { type: "web_search_20260101", name: "web_search" }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(true)
  })

  test("typed tool named internet_research matches", () => {
    const tool: AnthropicTool = { type: "internet_research_20260101", name: "internet_research" }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(true)
  })

  test("future versioned type — detected by name, not type string", () => {
    const tool: AnthropicTool = { type: "web_search_20260101", name: "web_search" }
    // tool.type changed, but tool.name is still "web_search" — still detected
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(true)
  })

  test("custom tool named web_search WITH input_schema — NOT matched", () => {
    const tool: AnthropicTool = {
      name: "web_search",
      input_schema: { type: "object", properties: {} },
    }
    // isTypedTool returns false because input_schema is present
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(false)
  })

  test("custom tool named search WITH input_schema — NOT matched", () => {
    const tool: AnthropicTool = {
      name: "search",
      input_schema: { type: "object", properties: {} },
    }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(false)
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
      required: string[]
    }
    expect(params.properties.query).toBeDefined()
    expect(params.required).toContain("query")
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail (module not found)**

```bash
bun test tests/web-search.test.ts
```

Expected: error — `Cannot find module '~/services/web-search/tool-definition'`

- [ ] **Step 3: Create `src/services/web-search/tool-definition.ts`**

```typescript
import type { Tool } from "~/services/copilot/create-chat-completions"

export const WEB_SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "internet_search",
  "brave_search",
  "bing_search",
  "google_search",
  "find_online",
  "internet_research",
])

export const WEB_SEARCH_FUNCTION_TOOL: Tool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current information. Use this when you need up-to-date facts, recent events, or information beyond your training data.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test tests/web-search.test.ts
```

Expected: all tests in the `WEB_SEARCH_TOOL_NAMES`, `Typed tool detection guard`, and `WEB_SEARCH_FUNCTION_TOOL` describe blocks pass.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/web-search/tool-definition.ts tests/web-search.test.ts
SKIP_SIMPLE_GIT_HOOKS=1 git commit -m "feat: add WEB_SEARCH_TOOL_NAMES and WEB_SEARCH_FUNCTION_TOOL constants"
```

---

### Task 3: Brave Search API client

**Files:**
- Create: `src/services/web-search/brave.ts`
- Modify: `tests/web-search.test.ts` (add Brave client tests)

The Brave Web Search API endpoint is:
```
GET https://api.search.brave.com/res/v1/web/search?q=<query>&count=5
Headers:
  Accept: application/json
  Accept-Encoding: gzip
  X-Subscription-Token: <apiKey>
```

Successful response shape (only fields we use):
```typescript
{
  web?: {
    results?: Array<{
      title: string
      url: string
      description?: string
    }>
  }
}
```

- [ ] **Step 1: Add Brave client tests to `tests/web-search.test.ts`**

Append these `describe` blocks at the end of the file:

```typescript
import { BraveSearchError, type BraveSearchResult } from "~/services/web-search/types"
import * as braveModule from "~/services/web-search/brave"

describe("searchBrave — result formatting", () => {
  test("formats top 5 results as BraveSearchResult[]", async () => {
    // Mock global fetch for this test
    const mockResponse = {
      web: {
        results: [
          { title: "Result 1", url: "https://example.com/1", description: "Desc 1" },
          { title: "Result 2", url: "https://example.com/2", description: "Desc 2" },
          { title: "Result 3", url: "https://example.com/3", description: "Desc 3" },
          { title: "Result 4", url: "https://example.com/4", description: "Desc 4" },
          { title: "Result 5", url: "https://example.com/5", description: "Desc 5" },
        ],
      },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })

    try {
      const results = await braveModule.searchBrave("test query", "fake-api-key")
      expect(results).toHaveLength(5)
      expect(results[0]).toEqual({
        title: "Result 1",
        url: "https://example.com/1",
        description: "Desc 1",
      })
      expect(results[4]?.url).toBe("https://example.com/5")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns empty array when web.results is empty", async () => {
    const mockResponse = { web: { results: [] } }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })

    try {
      const results = await braveModule.searchBrave("nothing here", "fake-api-key")
      expect(results).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns empty array when web key is absent", async () => {
    const mockResponse = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })

    try {
      const results = await braveModule.searchBrave("nothing", "fake-api-key")
      expect(results).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("uses empty string for missing description field", async () => {
    const mockResponse = {
      web: { results: [{ title: "T", url: "https://u.com" }] },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })

    try {
      const results = await braveModule.searchBrave("q", "fake-api-key")
      expect(results[0]?.description).toBe("")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("searchBrave — error handling", () => {
  test("throws BraveSearchError on non-200 response", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response("Forbidden", { status: 403 })

    try {
      await expect(braveModule.searchBrave("query", "bad-key")).rejects.toBeInstanceOf(BraveSearchError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("BraveSearchError reason includes status code on non-200", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response("Forbidden", { status: 403 })

    try {
      await braveModule.searchBrave("query", "bad-key").catch((e: BraveSearchError) => {
        expect(e.reason).toContain("403")
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("throws BraveSearchError on network failure", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error("network error")
    }

    try {
      await expect(braveModule.searchBrave("query", "key")).rejects.toBeInstanceOf(BraveSearchError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
bun test tests/web-search.test.ts
```

Expected: `Cannot find module '~/services/web-search/brave'`

- [ ] **Step 3: Create `src/services/web-search/brave.ts`**

```typescript
import { BraveSearchError, type BraveSearchResult } from "./types"

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
const TIMEOUT_MS = 5000
const MAX_RESULTS = 5

export async function searchBrave(
  query: string,
  apiKey: string,
): Promise<BraveSearchResult[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, TIMEOUT_MS)

  try {
    const url = new URL(BRAVE_SEARCH_URL)
    url.searchParams.set("q", query)
    url.searchParams.set("count", String(MAX_RESULTS))

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new BraveSearchError(`HTTP ${response.status}`)
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          title: string
          url: string
          description?: string
        }>
      }
    }

    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description ?? "",
    }))
  } catch (error) {
    if (error instanceof BraveSearchError) {
      throw error
    }
    const reason =
      error instanceof Error ? error.message : "unknown network error"
    throw new BraveSearchError(reason)
  } finally {
    clearTimeout(timeoutId)
  }
}
```

- [ ] **Step 4: Run the Brave client tests to verify they pass**

```bash
bun test tests/web-search.test.ts
```

Expected: all tests pass including the new `searchBrave` describe blocks.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/web-search/types.ts src/services/web-search/brave.ts tests/web-search.test.ts
SKIP_SIMPLE_GIT_HOOKS=1 git commit -m "feat: add Brave Search API client with 5s timeout"
```

---

## Chunk 2: Interceptor

### Task 4: Web search interceptor (tool-call loop)

**Files:**
- Create: `src/services/web-search/interceptor.ts`
- Modify: `tests/web-search.test.ts` (add interceptor tests)

The interceptor receives an OpenAI `ChatCompletionsPayload` with the `web_search` function tool already injected. It knows nothing about Anthropic types. Its job:
1. Call Copilot non-streaming (first pass)
2. If `finish_reason !== "tool_calls"` or no `web_search` call → return as-is
3. If `web_search` call found → call Brave → build messages → call Copilot again (second pass, original stream flag)

The `formatSearchResults` helper is a pure function that converts `BraveSearchResult[]` into the plain-text string injected as the tool result. It also handles the zero-results case and the failure case.

- [ ] **Step 1: Add interceptor tests to `tests/web-search.test.ts`**

Append these imports and describe blocks at the end of the file. Tests use `spyOn` from `bun:test` (Bun's ESM-compatible mocking API) — never `@ts-ignore` namespace reassignment, which is read-only in native ESM.

```typescript
import { webSearchInterceptor } from "~/services/web-search/interceptor"
import type { ChatCompletionsPayload, ChatCompletionResponse, Message } from "~/services/copilot/create-chat-completions"
import * as createChatCompletionsModule from "~/services/copilot/create-chat-completions"

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
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
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
    const createSpy = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValue(stopResponse)

    const result = await webSearchInterceptor(makePayload())

    expect(result).toEqual(stopResponse)
    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  test("returns response as-is when tool_calls is for a different tool", async () => {
    const otherToolResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-1", name: "bash", arguments: '{"command":"ls"}' },
    ])
    const createSpy = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValue(otherToolResponse)

    const result = await webSearchInterceptor(makePayload())

    expect(result).toEqual(otherToolResponse)
    expect(createSpy).toHaveBeenCalledTimes(1)
  })
})

describe("webSearchInterceptor — search path", () => {
  afterEach(() => {
    mock.restore()
  })

  test("calls Brave and makes a second Copilot call when web_search is triggered", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: '{"query":"latest AI news"}' },
    ])
    const finalResponse = makeCopilotResponse("stop")
    const braveResults = [
      { title: "AI News", url: "https://ainews.com", description: "Latest AI developments" },
    ]

    const createSpy = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockResolvedValue(braveResults)

    const result = await webSearchInterceptor(makePayload())

    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(result).toEqual(finalResponse)
    // First pass must be non-streaming
    expect(createSpy.mock.calls[0]?.[0]?.stream).toBe(false)
  })

  test("second pass uses original stream flag", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: '{"query":"news"}' },
    ])
    const finalResponse = makeCopilotResponse("stop")

    const createSpy = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockResolvedValue([])

    // streaming request
    await webSearchInterceptor(makePayload(true))

    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(createSpy.mock.calls[0]?.[0]?.stream).toBe(false)   // first pass always non-streaming
    expect(createSpy.mock.calls[1]?.[0]?.stream).toBe(true)    // second pass uses original stream=true
  })

  test("injects stub tool results for non-search tool_calls alongside web_search", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: '{"query":"q"}' },
      { id: "tc-bash", name: "bash", arguments: '{"command":"ls"}' },
    ])
    const finalResponse = makeCopilotResponse("stop")

    const createSpy = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockResolvedValue([])

    await webSearchInterceptor(makePayload())

    // Messages in second call should include tool results for BOTH tool_calls
    const secondCallMessages = createSpy.mock.calls[1]?.[0]?.messages as Message[]
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

    const createSpy = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockRejectedValue(new BraveSearchError("HTTP 429"))

    await webSearchInterceptor(makePayload())

    expect(createSpy).toHaveBeenCalledTimes(2)
    const secondCallMessages = createSpy.mock.calls[1]?.[0]?.messages as Message[]
    const toolMsg = secondCallMessages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain("Web search failed")
    expect(toolMsg?.content).toContain("training data")
  })

  test("injects failure message when query JSON.parse fails", async () => {
    const firstResponse = makeCopilotResponse("tool_calls", [
      { id: "tc-ws", name: "web_search", arguments: "INVALID_JSON" },
    ])
    const finalResponse = makeCopilotResponse("stop")

    const createSpy = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(finalResponse)
    spyOn(braveModule, "searchBrave").mockResolvedValue([])

    await webSearchInterceptor(makePayload())

    expect(createSpy).toHaveBeenCalledTimes(2)
    const secondCallMessages = createSpy.mock.calls[1]?.[0]?.messages as Message[]
    const toolMsg = secondCallMessages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain("Web search failed")
  })
})
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
bun test tests/web-search.test.ts 2>&1 | head -20
```

Expected: `Cannot find module '~/services/web-search/interceptor'`

- [ ] **Step 3: Create `src/services/web-search/interceptor.ts`**

```typescript
import consola from "consola"

import {
  createChatCompletions,
  type ChatCompletionsPayload,
  type ChatCompletionResponse,
  type Message,
} from "~/services/copilot/create-chat-completions"
import { state } from "~/lib/state"

import { searchBrave } from "./brave"
import { BraveSearchError, type BraveSearchResult } from "./types"

export async function webSearchInterceptor(
  payload: ChatCompletionsPayload,
): ReturnType<typeof createChatCompletions> {
  // First pass: always non-streaming so we can inspect finish_reason
  const firstPassPayload: ChatCompletionsPayload = { ...payload, stream: false }
  const firstResponse = (await createChatCompletions(
    firstPassPayload,
  )) as ChatCompletionResponse

  const choice = firstResponse.choices[0]
  if (!choice || choice.finish_reason !== "tool_calls" || !choice.message.tool_calls) {
    return firstResponse
  }

  const webSearchCall = choice.message.tool_calls.find(
    (tc) => tc.function.name === "web_search",
  )
  if (!webSearchCall) {
    // tool_calls but no web_search call — return first response as-is
    return firstResponse
  }

  // Parse query
  let toolResultContent: string | undefined
  try {
    const args = JSON.parse(webSearchCall.function.arguments) as { query: string }
    const query = args.query

    let results: BraveSearchResult[]
    try {
      if (!state.braveApiKey) throw new BraveSearchError("BRAVE_API_KEY not set")
      results = await searchBrave(query, state.braveApiKey)
    } catch (error) {
      const reason = error instanceof BraveSearchError ? error.reason : String(error)
      consola.warn(`Web search failed: ${reason}`)
      toolResultContent = `Web search failed: ${reason}\nPlease answer based on your training data and let the user know that web search is currently unavailable.`
    }

    if (toolResultContent === undefined) {
      toolResultContent = formatSearchResults(query, results!)
    }
  } catch {
    consola.warn("Web search: failed to parse tool call arguments")
    toolResultContent =
      "Web search failed: could not parse search query.\nPlease answer based on your training data and let the user know that web search is currently unavailable."
  }

  // Build messages for second pass
  const assistantMessage: Message = {
    role: "assistant",
    content: choice.message.content ?? null,
    tool_calls: choice.message.tool_calls,
  }

  // Inject a tool result for every tool_call in the assistant message.
  // Non-search tool calls get an empty stub so Copilot's second pass has
  // a complete result set (required — partial results cause rejection).
  const toolResultMessages: Message[] = choice.message.tool_calls.map((tc) => ({
    role: "tool",
    tool_call_id: tc.id,
    // toolResultContent is always set before reaching this point (both try branches assign it)
    content: tc.id === webSearchCall.id ? (toolResultContent ?? "") : "",
  }))

  const secondPassMessages: Message[] = [
    ...payload.messages,
    assistantMessage,
    ...toolResultMessages,
  ]

  // Second pass: use original stream flag
  return createChatCompletions({
    ...payload,
    messages: secondPassMessages,
  })
}

function formatSearchResults(query: string, results: BraveSearchResult[]): string {
  if (results.length === 0) {
    return `No results found for: "${query}"`
  }

  const lines = [`Web search results for: "${query}"`, ""]
  for (const [i, result] of results.entries()) {
    lines.push(`${i + 1}. Title: ${result.title}`)
    lines.push(`   URL: ${result.url}`)
    lines.push(`   Snippet: ${result.description}`)
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}
```

- [ ] **Step 4: Run the interceptor tests to verify they pass**

```bash
bun test tests/web-search.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck deferred to Task 5**

The interceptor references `state.braveApiKey`, which is not added to the `State` interface until Task 5. Running `bun run typecheck` here will fail with `Property 'braveApiKey' does not exist`. Proceed to commit; the typecheck is covered in Task 5 Step 3 once the state field is defined.

- [ ] **Step 6: Commit**

```bash
git add src/services/web-search/interceptor.ts tests/web-search.test.ts
SKIP_SIMPLE_GIT_HOOKS=1 git commit -m "feat: add web search interceptor (tool-call loop)"
```

---

## Chunk 3: Detection, State, Startup, Handler Wiring

### Task 5: State and startup changes

**Files:**
- Modify: `src/lib/state.ts`
- Modify: `src/start.ts`

- [ ] **Step 1: Add `braveApiKey` to `State` and `isWebSearchEnabled()` to `src/lib/state.ts`**

Current `State` interface ends at `lastRequestTimestamp?: number`. Add after it:

```typescript
  braveApiKey?: string
```

And add this function after the `state` export:

```typescript
export function isWebSearchEnabled(): boolean {
  return !!state.braveApiKey
}
```

- [ ] **Step 2: Add env var reading to `src/start.ts`**

In `runServer`, after `state.showToken = options.showToken` (around line 47), add:

```typescript
  const braveApiKey = process.env.BRAVE_API_KEY
  if (braveApiKey) {
    state.braveApiKey = braveApiKey
    consola.info("Web search enabled (Brave) — note: each web search request uses 2-3 Copilot API calls")
  }
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run all tests to verify nothing broke**

```bash
bun test
```

Expected: all existing tests pass, no new failures.

- [ ] **Step 5: Commit**

```bash
git add src/lib/state.ts src/start.ts
SKIP_SIMPLE_GIT_HOOKS=1 git commit -m "feat: add braveApiKey to state and isWebSearchEnabled() helper"
```

---

### Task 6: Web search detection module

**Files:**
- Create: `src/routes/messages/web-search-detection.ts`
- Modify: `tests/web-search.test.ts` (add detection tests)

This module has two exports:
1. `detectWebSearchIntent(payload)` — Path 1 (zero cost typed tool check) then Path 2 (preflight Copilot call)
2. `stripWebSearchTypedTools(payload)` — returns new payload without web search typed tools

For Path 2's preflight model: use `state.models?.data`, pick the first model whose ID is different from `payload.model`. If there's only one model or `state.models` is unavailable, fall back to `payload.model`. The preflight uses `stream: false` and `max_tokens: 5`.

The last user message for Path 2 is extracted by scanning `payload.messages` from the end for the first `role: "user"` entry. If the message content is a string, use it directly. If it's an array of content blocks, join all `type: "text"` block texts.

- [ ] **Step 1: Add detection tests to `tests/web-search.test.ts`**

Append at the end of the file:

```typescript
import {
  detectWebSearchIntent,
  stripWebSearchTypedTools,
} from "~/routes/messages/web-search-detection"
import * as stateModule from "~/lib/state"

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
      { name: "bash", description: "Run bash", input_schema: { type: "object", properties: {}, required: [] } },
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
      { name: "my_tool", description: "A tool", input_schema: { type: "object", properties: {} } },
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

    // Set up spy to verify Path 1 short-circuits before any preflight call
    const createSpy = spyOn(createChatCompletionsModule, "createChatCompletions")

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
    const payload = makeAnthropicPayload(undefined, "What happened in the news today?")

    spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValue(makePreflightResponse("yes"))

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(true)
  })

  test("returns false when preflight responds no", async () => {
    const payload = makeAnthropicPayload(undefined, "Write me a poem")

    spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockResolvedValue(makePreflightResponse("no"))

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(false)
  })

  test("returns false (and logs warning) when preflight call throws", async () => {
    const payload = makeAnthropicPayload(undefined, "Search for something")

    spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockRejectedValue(new Error("network failure"))

    const result = await detectWebSearchIntent(payload)

    expect(result).toBe(false)
    // No exception propagated — graceful fallback
  })
})
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
bun test tests/web-search.test.ts 2>&1 | head -20
```

Expected: `Cannot find module '~/routes/messages/web-search-detection'`

- [ ] **Step 3: Create `src/routes/messages/web-search-detection.ts`**

```typescript
import consola from "consola"

import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { state } from "~/lib/state"
import { WEB_SEARCH_TOOL_NAMES } from "~/services/web-search/tool-definition"

import { isTypedTool, type AnthropicMessagesPayload } from "./anthropic-types"

/**
 * Returns true if this request should trigger a web search.
 *
 * Path 1: Zero-cost — checks if any typed tool in the request has a name
 * in WEB_SEARCH_TOOL_NAMES. Short-circuits to true without an API call.
 *
 * Path 2: Only fires when Path 1 is false. Sends a lightweight preflight
 * classification request to Copilot asking whether the last user message
 * requires real-time web data. Falls back to false on any failure.
 */
export async function detectWebSearchIntent(
  payload: AnthropicMessagesPayload,
): Promise<boolean> {
  // Path 1: typed tool detection (free)
  const hasWebSearchTypedTool = payload.tools?.some(
    (tool) => isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name),
  ) ?? false

  if (hasWebSearchTypedTool) {
    return true
  }

  // Path 2: natural language preflight (costs one Copilot API call)
  const lastUserMessage = getLastUserMessageText(payload)
  if (!lastUserMessage) {
    return false
  }

  try {
    const preflightModel = getPreflightModel(payload.model)
    const response = (await createChatCompletions({
      model: preflightModel,
      stream: false,
      max_tokens: 5,
      messages: [
        {
          role: "system",
          content:
            'You are a classifier. Answer only "yes" or "no". No explanation.',
        },
        {
          role: "user",
          content: `Does this message require searching the web for current or real-time information?\nMessage: "${lastUserMessage}"`,
        },
      ],
    })) as ChatCompletionResponse

    const answer = response.choices[0]?.message.content?.trim().toLowerCase() ?? ""
    return answer === "yes"
  } catch (error) {
    consola.warn(
      "Web search preflight classification failed, treating as no-search-needed:",
      error,
    )
    return false
  }
}

/**
 * Returns a new payload with all typed web search tools removed.
 * Does not mutate the input.
 */
export function stripWebSearchTypedTools(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  return {
    ...payload,
    tools: payload.tools?.filter(
      (tool) => !(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)),
    ),
  }
}

function getLastUserMessageText(payload: AnthropicMessagesPayload): string {
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const msg = payload.messages[i]
    if (msg?.role !== "user") continue
    if (typeof msg.content === "string") return msg.content
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join(" ")
    }
  }
  return ""
}

function getPreflightModel(requestModel: string): string {
  const models = state.models?.data ?? []
  const alternative = models.find((m) => m.id !== requestModel)
  return alternative?.id ?? requestModel
}
```

- [ ] **Step 4: Run the detection tests to verify they pass**

```bash
bun test tests/web-search.test.ts
```

Expected: all detection tests pass.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/messages/web-search-detection.ts tests/web-search.test.ts
SKIP_SIMPLE_GIT_HOOKS=1 git commit -m "feat: add web search detection and stripping module"
```

---

### Task 7: Wire everything into handler.ts

**Files:**
- Modify: `src/routes/messages/handler.ts`
- Modify: `tests/web-search.test.ts` (add end-to-end disabled test)

This task restructures the handler to move `manualApprove` before translation and branch on web search intent. The current handler code is:

```typescript
// Current (before change):
const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
// ...debug log...
const openAIPayload = translateToOpenAI(anthropicPayload)
// ...debug log...
if (state.manualApprove) {
  await awaitApproval()
}
const response = await createChatCompletions(openAIPayload)
```

The new structure:

```typescript
// New (after change):
const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
// ...debug log...

if (state.manualApprove) {
  await awaitApproval()
}

let response: Awaited<ReturnType<typeof createChatCompletions>>

if (isWebSearchEnabled() && await detectWebSearchIntent(anthropicPayload)) {
  const cleanedPayload = stripWebSearchTypedTools(anthropicPayload)
  const openAIPayload = translateToOpenAI(cleanedPayload)
  consola.debug("Translated OpenAI request payload (web search):", JSON.stringify(openAIPayload))
  openAIPayload.tools = [...(openAIPayload.tools ?? []), WEB_SEARCH_FUNCTION_TOOL]
  response = await webSearchInterceptor(openAIPayload)
} else {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug("Translated OpenAI request payload:", JSON.stringify(openAIPayload))
  response = await createChatCompletions(openAIPayload)
}
```

Add these imports to the handler:
```typescript
import { isWebSearchEnabled } from "~/lib/state"
import { detectWebSearchIntent, stripWebSearchTypedTools } from "./web-search-detection"
import { webSearchInterceptor } from "~/services/web-search/interceptor"
import { WEB_SEARCH_FUNCTION_TOOL } from "~/services/web-search/tool-definition"
```

- [ ] **Step 1: Add end-to-end disabled test to `tests/web-search.test.ts`**

Append at the end:

```typescript
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
```

- [ ] **Step 2: Run the new tests to verify they pass**

```bash
bun test tests/web-search.test.ts
```

Expected: the `isWebSearchEnabled` tests pass (the helper is already implemented from Task 5).

- [ ] **Step 3: Rewrite `src/routes/messages/handler.ts`**

Replace the full file contents with the restructured version. Preserve all existing debug logging. The file after rewrite:

```typescript
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { isWebSearchEnabled, state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { webSearchInterceptor } from "~/services/web-search/interceptor"
import { WEB_SEARCH_FUNCTION_TOOL } from "~/services/web-search/tool-definition"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import {
  detectWebSearchIntent,
  stripWebSearchTypedTools,
} from "./web-search-detection"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  if (state.manualApprove) {
    await awaitApproval()
  }

  let response: Awaited<ReturnType<typeof createChatCompletions>>

  if (isWebSearchEnabled() && (await detectWebSearchIntent(anthropicPayload))) {
    const cleanedPayload = stripWebSearchTypedTools(anthropicPayload)
    const openAIPayload = translateToOpenAI(cleanedPayload)
    openAIPayload.tools = [...(openAIPayload.tools ?? []), WEB_SEARCH_FUNCTION_TOOL]
    consola.debug(
      "Translated OpenAI request payload (web search):",
      JSON.stringify(openAIPayload),
    )
    response = await webSearchInterceptor(openAIPayload)
  } else {
    const openAIPayload = translateToOpenAI(anthropicPayload)
    consola.debug(
      "Translated OpenAI request payload:",
      JSON.stringify(openAIPayload),
    )
    response = await createChatCompletions(openAIPayload)
  }

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
```

- [ ] **Step 4: Run all tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Run build**

```bash
bun run build
```

Expected: completes without errors.

- [ ] **Step 7: Commit**

```bash
git add src/routes/messages/handler.ts tests/web-search.test.ts
SKIP_SIMPLE_GIT_HOOKS=1 git commit -m "feat: wire web search into message handler"
```

---

## Final Verification

- [ ] **Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Run build**

```bash
bun run build
```

Expected: `dist/` built without errors.
