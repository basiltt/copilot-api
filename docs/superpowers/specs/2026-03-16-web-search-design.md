# Web Search Design Spec

**Date:** 2026-03-16
**Project:** copilot-api
**Status:** Approved

---

## Goal

Implement a transparent server-side web search capability in copilot-api using the Brave Search API. When a client (e.g. Claude Code) requests web search via the Anthropic `web_search` typed tool or via natural language intent, the proxy performs the search itself and injects results into the conversation before forwarding to Copilot — replicating the server-side behavior of the real Anthropic API.

---

## Background

The Anthropic API supports a `web_search_20250305` typed tool (and future versioned variants). When present, Anthropic handles the search server-side: the model emits a `server_tool_use` block, Anthropic runs the search, and injects a `web_search_tool_result` block — all transparently. The client never sees the loop.

Copilot has no equivalent capability. Currently, copilot-api silently filters typed tools including `web_search_*`, so the model answers from training data only with no indication that search was unavailable.

This design adds a web search interceptor that replicates the Anthropic server-side behavior using Brave Search, so clients get current web data regardless of whether they are routed through Copilot.

---

## Architecture

### Activation

Web search is **opt-out**: automatically enabled whenever `BRAVE_API_KEY` is set in the environment. No CLI flag required. If the key is absent, behavior falls back to the existing silent-filter path.

### High-Level Flow

```
Client (Claude Code)
  │  POST /v1/messages  { tools: [web_search_20250305, Bash, ...], messages: [...] }
  ▼
handler.ts
  │  translateToOpenAI(anthropicPayload)
  │  isWebSearchEnabled() → true
  │  → webSearchInterceptor(openAIPayload)
  ▼
interceptor.ts
  │  detect web search intent (typed tool OR natural language)
  │  if no intent → call createChatCompletions directly, return
  │  if intent detected:
  │    strip web_search typed tools
  │    inject web_search function tool
  │    call Copilot (non-streaming)
  │
  ├─ finish_reason: "stop" → return response as-is
  └─ finish_reason: "tool_calls", name: "web_search"
       │  extract query from arguments
       ▼
  brave.ts
       │  GET https://api.search.brave.com/res/v1/web/search?q=<query>
       │  returns top 5 { title, url, description } results
       ▼
  interceptor.ts
       │  append assistant tool_call message + tool result message
       │  re-call Copilot (respects original stream flag)
       │  return final response
  ▼
handler.ts
  │  translateToAnthropic(response)
  │  return to client
  ▼
Client receives answer with current web data baked in
```

---

## Detection

Two independent paths. Either one triggers the web search flow. Path 1 is checked first (zero cost); Path 2 only fires when Path 1 is false.

### Path 1: Typed Tool Detection

Match any typed tool (no `input_schema`) whose `name` is in the known web search names set:

```typescript
const WEB_SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "internet_search",
  "search",
  "brave_search",
  "bing_search",
  "google_search",
  "find_online",
  "internet_research",
])

const hasWebSearchTool = payload.tools?.some(
  (tool) => isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)
)
```

Detection uses `tool.name` (stable across versions) rather than `tool.type` (e.g. `web_search_20250305`), so future versioned variants like `web_search_20260101` are automatically handled.

### Path 2: Natural Language Detection

Only triggered when Path 1 is false. Sends a lightweight preflight classification request to Copilot using only the **last user message** in the conversation (the most recent turn, not the full history — sufficient for intent detection and keeps the preflight call cheap):

```
System: You are a classifier. Answer only "yes" or "no". No explanation.
User: Does this message require searching the web for current or real-time information?
Message: "<last user message text>"
```

- Response `"yes"` (case-insensitive) → trigger web search
- Response `"no"` or any other value → skip web search
- If the preflight call itself fails → log a warning, treat as "no", continue without search (never block the main request)

---

## The Injected Function Tool

When web search intent is detected, the interceptor strips all web search typed tools from the tools array and injects this OpenAI function tool in their place:

```typescript
{
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current information. Use this when you need up-to-date facts, recent events, or information beyond your training data.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query"
        }
      },
      required: ["query"]
    }
  }
}
```

---

## The Tool-Call Loop

The interceptor handles at most **one search per request** — no recursive loop. If Copilot calls `web_search` again in the final pass, the response is returned as-is.

**Step-by-step:**

1. Receive translated OpenAI payload
2. Run detection (Path 1 then Path 2)
3. If no intent → delegate to `createChatCompletions` directly and return
4. Strip web search typed tools, inject function tool
5. Call Copilot **non-streaming** (regardless of original `stream` flag)
6. Inspect `finish_reason`:
   - Not `"tool_calls"` → return response as-is (model answered without searching)
   - `"tool_calls"` with `name !== "web_search"` → return response as-is (model called a different tool)
   - `"tool_calls"` with `name === "web_search"` → proceed to step 7
7. Parse `query` from `tool_calls[].function.arguments`
8. Call Brave Search API → top 5 results or `BraveSearchError`
9. Format results as plain text (see below)
10. Append to messages:
    - `{ role: "assistant", tool_calls: [...] }` — Copilot's tool_use response
    - `{ role: "tool", tool_call_id: "...", content: "<formatted results>" }`
11. Re-call Copilot with the **original `stream` flag** — streaming clients get a streamed final response
12. Return final response to `handler.ts`

**Formatted search results (injected as tool result content):**

```
Web search results for: "<query>"

1. Title: <title>
   URL: <url>
   Snippet: <description>

2. ...

[up to 5 results]
```

Plain text — no JSON wrapping — so Copilot's model reads it naturally.

**Zero results:**
```
No results found for: "<query>"
```

**Brave API failure:**
```
Web search failed: <reason>
Please answer based on your training data and let the user know that web search is currently unavailable.
```

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| `BRAVE_API_KEY` missing | `isWebSearchEnabled()` → false, silent passthrough (existing behavior) |
| Brave API non-200 | Inject failure message as tool result, re-submit to Copilot, which informs user gracefully |
| Brave API network error/timeout | Same as non-200 |
| Brave returns 0 results | Inject "No results found" as tool result |
| Preflight classification call fails | Log warning, treat as "no search needed", continue normally |
| Copilot second pass fails | Propagate via existing error handling in `handler.ts` |

The request **always completes** from the client's perspective — a Brave failure never produces a 5xx to the client.

---

## New Files

### `src/services/web-search/types.ts`
Shared types only. No logic.
- `BraveSearchResult` — `{ title: string; url: string; description: string }`
- `BraveSearchError` — typed error class with `reason: string`
- `WebSearchConfig` — `{ apiKey: string; maxResults: number }`

### `src/services/web-search/brave.ts`
Single responsibility: call Brave Search API, return structured results.
- `searchBrave(query: string, config: WebSearchConfig): Promise<BraveSearchResult[]>`
- Throws `BraveSearchError` on non-200 or network failure
- No knowledge of Copilot or the tool-call loop

### `src/services/web-search/tool-definition.ts`
Constants only. No logic.
- `WEB_SEARCH_TOOL_NAMES: Set<string>` — known web search tool names
- `WEB_SEARCH_FUNCTION_TOOL: Tool` — the injected OpenAI function tool definition

### `src/services/web-search/interceptor.ts`
Single responsibility: detection + tool-call loop.
- `webSearchInterceptor(payload: ChatCompletionsPayload): Promise<ChatCompletionResponse | EventStream>`
- Calls `brave.ts`, `tool-definition.ts`, and `createChatCompletions`
- No knowledge of Anthropic types

---

## Modified Files

### `src/lib/state.ts`
- Add `braveApiKey?: string` field to `State` interface
- Add `isWebSearchEnabled(): boolean` helper — `return !!state.braveApiKey`

### `src/start.ts`
- Read `process.env.BRAVE_API_KEY` at startup, store in `state.braveApiKey`
- Log `consola.info("Web search enabled (Brave)")` if key is present

### `src/routes/messages/handler.ts`
- After `translateToOpenAI`, add branch:
  ```typescript
  const response = isWebSearchEnabled()
    ? await webSearchInterceptor(openAIPayload)
    : await createChatCompletions(openAIPayload)
  ```
- The rest of the handler (streaming/non-streaming Anthropic translation) is unchanged
- **Note:** The `manualApprove` prompt fires once before the interceptor. The interceptor's internal Copilot calls (first pass + second pass) bypass manual approval intentionally — they are implementation details of the web search loop, not new user-visible requests.

---

## Testing

New test file: `tests/web-search.test.ts`

| Test | What it verifies |
|------|-----------------|
| Typed tool detection — `web_search` name | `WEB_SEARCH_TOOL_NAMES` match |
| Typed tool detection — `internet_research` name | Variant name match |
| Typed tool detection — `web_search_20260101` type (future version) | `tool.name` used, not `tool.type` |
| Typed tool detection — custom tool named `web_search` (has `input_schema`) | `isTypedTool` guard prevents false positive |
| Natural language — preflight returns "yes" | Search triggered |
| Natural language — preflight returns "no" | Search skipped |
| Natural language — preflight call fails | Warning logged, search skipped, request continues |
| Interceptor — Copilot returns `stop` | No search, response returned as-is |
| Interceptor — Copilot returns `tool_calls` for `web_search` | Brave called, results injected, second Copilot call made |
| Interceptor — Copilot returns `tool_calls` for different tool | No search, response returned as-is |
| Brave API — successful response | Top 5 results formatted correctly |
| Brave API — non-200 response | `BraveSearchError` thrown, failure message injected |
| Brave API — zero results | "No results found" message injected |
| End-to-end — `BRAVE_API_KEY` absent | `isWebSearchEnabled()` false, interceptor never called |

---

## Out of Scope

- Page content fetching (snippets only)
- Multiple searches per request (max 1 loop)
- Streaming the first Copilot pass (always buffered for tool-call detection)
- Caching search results
- User-facing configuration beyond `BRAVE_API_KEY` env var
