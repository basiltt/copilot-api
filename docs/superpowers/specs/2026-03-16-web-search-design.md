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

Detection and stripping happen **on the Anthropic payload** (`AnthropicMessagesPayload`) in `handler.ts`, **before** `translateToOpenAI` is called. This is the correct layer because:

- `translateAnthropicToolsToOpenAI` already strips all typed tools — there is nothing to detect or strip in the translated OpenAI payload.
- `isTypedTool` is defined for Anthropic types and has no meaning on the already-translated OpenAI payload.

```
Client (Claude Code)
  │  POST /v1/messages  { tools: [web_search_20250305, Bash, ...], messages: [...] }
  ▼
handler.ts
  │  isWebSearchEnabled() → true
  │  detectWebSearchIntent(anthropicPayload) → true/false
  │  if false → translateToOpenAI → createChatCompletions directly, return
  │  if true:
  │    stripWebSearchTypedTools(anthropicPayload) → cleanedPayload
  │    translateToOpenAI(cleanedPayload) → openAIPayload (no typed tools)
  │    inject web_search function tool into openAIPayload.tools
  │    → webSearchInterceptor(openAIPayload)
  ▼
interceptor.ts
  │  call Copilot (non-streaming)
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
  │  translateToAnthropic(response) — or stream translation for streaming
  │  return to client
  ▼
Client receives answer with current web data baked in
```

---

## Detection

Detection runs on the **Anthropic payload** in `handler.ts`, before translation. Two independent paths. Either one triggers the web search flow. Path 1 is checked first (zero cost); Path 2 only fires when Path 1 is false.

### Path 1: Typed Tool Detection

Match any typed tool (no `input_schema`) whose `name` is in the known web search names set:

```typescript
const WEB_SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "internet_search",
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

**Note on `"search"` exclusion:** The generic name `"search"` is intentionally excluded from `WEB_SEARCH_TOOL_NAMES`. Users commonly define custom tools named `"search"` for local codebase search, database search, etc. Including it would cause false positives. The remaining names are specific enough to be unambiguous.

**Note on typed-tool guard:** The `isTypedTool(tool)` guard ensures that a custom tool (one with `input_schema`) named `"web_search"` is never mistakenly triggered. Only Anthropic-managed server tools (no `input_schema`) trigger the web search path.

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

**Performance cost:** Path 2 fires an extra Copilot round-trip for every request that lacks a typed web search tool. For Claude Code sessions — which send many requests for Bash, file reads, and coding tasks — this means nearly every request pays a preflight cost. This is acceptable for users who want natural language search detection; however, to manage cost, the implementation should use a small/fast model for the preflight call rather than the model in the original request. The preflight call always uses `stream: false` and a minimal `max_tokens: 5`.

**Known limitation:** The last-message-only approach can fail to detect web search intent in multi-turn conversations where the intent was established earlier (e.g., "What about news from last week?" after a prior research exchange). This is acceptable for v1; the classifier will miss some cases and the model will fall back to training data.

---

## Stripping Typed Web Search Tools

When Path 1 is true, the web search typed tools are stripped from the Anthropic payload **before** `translateToOpenAI` is called:

```typescript
function stripWebSearchTypedTools(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  return {
    ...payload,
    tools: payload.tools?.filter(
      (tool) => !(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)),
    ),
  }
}
```

This produces a clean Anthropic payload where `translateToOpenAI` can proceed normally — any remaining typed tools (e.g., `bash_20250124`) are already handled by `translateAnthropicToolsToOpenAI`'s existing filter.

---

## The Injected Function Tool

After translation, the interceptor adds this OpenAI function tool to `openAIPayload.tools`:

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

**`tool_choice` passthrough:** If the original Anthropic request had `tool_choice: { type: "tool", name: "web_search" }`, the translated OpenAI `tool_choice` will be `{ type: "function", function: { name: "web_search" } }`. Since the injected function tool is also named `"web_search"`, this continues to work correctly — no adjustment to `tool_choice` is needed.

**`tool_choice: web_search` forces a second pass:** When a client sends `tool_choice: { type: "tool", name: "web_search" }`, Copilot's first pass will always call `web_search` (the model is forced to). The `stop` branch of step 3 is therefore unreachable in this case — the interceptor will always proceed to the Brave search and second pass. This is correct behavior: the client explicitly requested a web search, so the proxy always performs one.

---

## The Tool-Call Loop

The interceptor handles at most **one search per request** — no recursive loop. If Copilot calls `web_search` again in the final pass, the response is returned as-is.

**Step-by-step:**

1. Receive translated OpenAI payload (typed web search tools already stripped, function tool injected)
2. Call Copilot **non-streaming** (regardless of original `stream` flag)
3. Inspect `finish_reason` on the first response:
   - Not `"tool_calls"` → return response as-is (model answered without searching)
   - `"tool_calls"` with no `web_search` call → return response as-is (model called a different tool)
   - `"tool_calls"` with one or more calls — if any is `name === "web_search"` → proceed to step 4
   - `"tool_calls"` with multiple calls including `web_search` → execute the web search; append all tool_call messages and the web_search result; for any other tool call IDs in the same assistant message, append a stub `{ role: "tool", tool_call_id: "<id>", content: "" }` message so Copilot's second pass receives a complete tool result for each tool_call in the assistant turn (required to avoid Copilot rejecting a partial result set)
4. Parse `query` from the `web_search` tool call's `function.arguments` (JSON). If `JSON.parse` fails, inject a failure message as tool result (treat as API failure) and proceed to step 7.
5. Call Brave Search API → top 5 results or `BraveSearchError` (timeout: 5 seconds; treat timeout as network failure)
6. Format results as plain text (see below)
7. Append to messages:
   - `{ role: "assistant", tool_calls: [...] }` — Copilot's full tool_use response (all tool calls, not just web_search)
   - `{ role: "tool", tool_call_id: "...", content: "<formatted results>" }` — result for the web_search call
8. Re-call Copilot with the **original `stream` flag** — streaming clients get a streamed final response
9. Return final response to `handler.ts`

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

**Brave API failure or JSON parse error:**
```
Web search failed: <reason>
Please answer based on your training data and let the user know that web search is currently unavailable.
```

---

## Return Type

The interceptor returns `ReturnType<typeof createChatCompletions>`, which resolves to:

```typescript
Promise<ChatCompletionResponse | AsyncIterableIterator<ServerSentEvent>>
```

where `ServerSentEvent` is from `fetch-event-stream`. `handler.ts` already discriminates these two cases using `isNonStreaming(response)` (`Object.hasOwn(response, "choices")`). The interceptor's return value plugs directly into the existing handler branch — no new type alias is needed.

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| `BRAVE_API_KEY` missing | `isWebSearchEnabled()` → false, silent passthrough (existing behavior) |
| Brave API non-200 | Inject failure message as tool result, re-submit to Copilot, which informs user gracefully |
| Brave API network error/timeout (5s limit) | Same as non-200 |
| Brave returns 0 results | Inject "No results found" as tool result |
| `JSON.parse` failure on tool arguments | Inject failure message as tool result, continue to second pass |
| Preflight classification call fails | Log warning, treat as "no search needed", continue normally |
| Copilot second pass fails | Propagate via existing error handling in `handler.ts` |

The request **always completes** from the client's perspective — a Brave failure never produces a 5xx to the client.

---

## New Files

### `src/services/web-search/types.ts`
Shared types only. No logic.
- `BraveSearchResult` — `{ title: string; url: string; description: string }`
- `BraveSearchError` — typed error class with `reason: string`

### `src/services/web-search/brave.ts`
Single responsibility: call Brave Search API, return structured results.
- `searchBrave(query: string, apiKey: string): Promise<BraveSearchResult[]>`
- Always fetches top 5 results (`count=5` query param, hardcoded)
- Applies a 5-second `AbortController` timeout
- Throws `BraveSearchError` on non-200, network failure, or timeout
- No knowledge of Copilot or the tool-call loop

### `src/services/web-search/tool-definition.ts`
Constants only. No logic.
- `WEB_SEARCH_TOOL_NAMES: Set<string>` — known web search tool names
- `WEB_SEARCH_FUNCTION_TOOL: Tool` — the injected OpenAI function tool definition

### `src/services/web-search/interceptor.ts`
Single responsibility: tool-call loop.
- `webSearchInterceptor(payload: ChatCompletionsPayload): ReturnType<typeof createChatCompletions>`
- Receives payload that already has the function tool injected
- Calls `brave.ts` and `createChatCompletions`
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
Detection, stripping, and injection all happen here, on the Anthropic payload, before translation.

**Current handler order (before this change):**
1. `checkRateLimit`
2. `c.req.json()` — parse payload
3. `translateToOpenAI`
4. `manualApprove` (if enabled)
5. `createChatCompletions`

**New handler order (after this change):**
1. `checkRateLimit`
2. `c.req.json()` — parse payload
3. `manualApprove` (if enabled) — moved before translation so approval fires before any Copilot call
4. `detectWebSearchIntent` + branch (web search or direct)
5. `translateToOpenAI` inside each branch
6. `createChatCompletions` / `webSearchInterceptor`

`manualApprove` is deliberately moved before translation — it fires once for the user-visible request before any Copilot call is made, which is its intended purpose. This is a harmless ordering change since `translateToOpenAI` is pure (no I/O).

```typescript
// Simplified handler pseudocode after changes:

const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

if (state.manualApprove) {
  await awaitApproval()
}

let response: Awaited<ReturnType<typeof createChatCompletions>>

if (isWebSearchEnabled() && await detectWebSearchIntent(anthropicPayload)) {
  const cleanedPayload = stripWebSearchTypedTools(anthropicPayload)
  const openAIPayload = translateToOpenAI(cleanedPayload)
  openAIPayload.tools = [...(openAIPayload.tools ?? []), WEB_SEARCH_FUNCTION_TOOL]
  response = await webSearchInterceptor(openAIPayload)
} else {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  response = await createChatCompletions(openAIPayload)
}
```

The rest of the handler (streaming/non-streaming Anthropic translation via `isNonStreaming`) is unchanged.

**Note:** The `manualApprove` prompt fires once before the branch. The interceptor's internal Copilot calls (first pass + second pass) bypass manual approval and rate limiting intentionally — they are implementation details of the web search loop, not new user-visible requests. Users with tight rate limits should be aware that web search requests consume 2–3 Copilot API calls total.

### `src/routes/messages/web-search-detection.ts` (new file)
A dedicated module for web search detection and stripping. It has access to both Anthropic types and `createChatCompletions`, and keeps `non-stream-translation.ts` focused on pure translation and `handler.ts` thin.

Exports:
- `detectWebSearchIntent(payload: AnthropicMessagesPayload): Promise<boolean>` — Path 1 (typed tool check, zero cost) then Path 2 (preflight Copilot call if Path 1 is false)
- `stripWebSearchTypedTools(payload: AnthropicMessagesPayload): AnthropicMessagesPayload` — returns new payload with web search typed tools removed

`WEB_SEARCH_TOOL_NAMES` (from `tool-definition.ts`) and `isTypedTool` (from `anthropic-types.ts`) are used internally by both functions.

The Path 2 preflight call uses `createChatCompletions` directly with a hardcoded small model (use the first available model from `state.models` that is not the request model, falling back to the request model if only one model is available), `stream: false`, and `max_tokens: 5`.

---

## Testing

New test file: `tests/web-search.test.ts`

| Test | What it verifies |
|------|-|
| Typed tool detection — `web_search` name | `WEB_SEARCH_TOOL_NAMES` match |
| Typed tool detection — `internet_research` name | Variant name match |
| Typed tool detection — `web_search_20260101` type (future version) | `tool.name` used, not `tool.type` |
| Typed tool detection — custom tool named `web_search` (has `input_schema`) | `isTypedTool` guard prevents false positive |
| Typed tool detection — custom tool named `search` (has `input_schema`) | `"search"` excluded from set, no false positive |
| Natural language — preflight returns "yes" | Search triggered |
| Natural language — preflight returns "no" | Search skipped |
| Natural language — preflight call fails | Warning logged, search skipped, request continues |
| Interceptor — Copilot returns `stop` | No search, response returned as-is |
| Interceptor — Copilot returns `tool_calls` for `web_search` | Brave called, results injected, second Copilot call made |
| Interceptor — Copilot returns `tool_calls` for different tool | No search, response returned as-is |
| Interceptor — Copilot returns `tool_calls` for `web_search` + another tool | Web search executed; stub result injected for non-search tool; second pass made |
| Interceptor — `tool_choice: { type: "function", function: { name: "web_search" } }` | Injected function tool satisfies the tool_choice correctly |
| Brave API — successful response | Top 5 results formatted correctly |
| Brave API — non-200 response | `BraveSearchError` thrown, failure message injected |
| Brave API — zero results | "No results found" message injected |
| Brave API — malformed JSON in tool arguments | Failure message injected, second pass made |
| End-to-end — `BRAVE_API_KEY` absent | `isWebSearchEnabled()` false, interceptor never called |

---

## Out of Scope

- Page content fetching (snippets only)
- Multiple searches per request (max 1 loop)
- Streaming the first Copilot pass (always buffered for tool-call detection)
- Caching search results
- User-facing configuration beyond `BRAVE_API_KEY` env var
- Disabling Path 2 natural language detection independently of Path 1
