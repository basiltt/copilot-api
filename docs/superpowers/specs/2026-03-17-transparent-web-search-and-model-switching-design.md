# Transparent Web Search + Context-Aware Model Switching — Design Spec

**Date:** 2026-03-17
**Status:** Approved

## Problem

Two related failures when AI agents (Claude Code, Claude Desktop, custom clients) use the proxy:

### 1. Web search never fires for AI agents

The proxy's web search only triggered when the client explicitly declared a `web_search` tool in the request. AI agents (especially Claude Code) never do this — they use their own built-in `WebFetch` tool, which bypasses the proxy entirely. Result: the proxy's Tavily integration is invisible to agents.

### 2. Token overflow crashes the proxy

When a long conversation (e.g. accumulated tool results, large system prompts) exceeds the context window of the Copilot-hosted model, Copilot returns `model_max_prompt_tokens_exceeded`. The proxy currently crashes with an unhelpful error (`Response {}`), and the client receives a double-wrapped stringified error JSON instead of the real structured error.

---

## Solution Overview

Four coordinated changes:

1. **Always-on web search** — when web search is enabled, inject `web_search` into every request unconditionally; let Copilot decide when to call it
2. **Fix streaming in interceptor** — the interceptor currently forces `stream: false` on the first pass; when Copilot doesn't call the tool, streaming must be preserved by re-issuing the request with the original `stream` flag
3. **Context-aware model switching** — before sending any request, check if the prompt exceeds the model's context window and auto-switch to the largest-context available model
4. **Upstream error forwarding** — forward Copilot's JSON error body directly (already approved in companion spec `2026-03-17-upstream-error-forwarding-design.md`)

---

## Section 1: Always-On Web Search Injection

### Current flow (messages route handler)

```
detectWebSearchIntent(payload)  ← preflight Copilot call (Path 2) or typed-tool check (Path 1)
  → true:  prepareWebSearchPayload → webSearchInterceptor
  → false: createChatCompletions directly
```

### New flow

```
if (isWebSearchEnabled()):
  prepareWebSearchPayload → webSearchInterceptor
else:
  createChatCompletions directly
```

Detection is removed entirely. When `TAVILY_API_KEY` or `BRAVE_API_KEY` is set, every request gets `WEB_SEARCH_FUNCTION_TOOL` injected into the OpenAI `tools` array. Copilot calls the tool when it judges the question needs real-time data; otherwise it ignores the tool. See Section 2 for how streaming is preserved on non-search requests.

### `web-search-detection.ts` — deleted

The entire file is removed. It contained:
- `detectWebSearchIntent()` — no longer needed
- `stripWebSearchTypedTools()` — no longer needed (typed web search tools from clients are already stripped by `translateAnthropicToolsToOpenAI` in `non-stream-translation.ts`, which filters to custom tools only)
- `getPreflightModel()` — no longer needed
- `getLastUserMessageText()` — no longer needed

The imports of `detectWebSearchIntent` and `stripWebSearchTypedTools` in `handler.ts` are removed.

Note on `stripWebSearchTypedTools`: `translateAnthropicToolsToOpenAI` filters to `!isTypedTool(tool)`, which strips all Anthropic typed tools (including `web_search_20250305`) before the OpenAI payload is built. This was already true on the non-web-search branch in the old flow, so removal of `stripWebSearchTypedTools` is safe.

Note on `tool_choice` pointing to a stripped typed tool (e.g. `tool_choice: { type: "tool", name: "web_search_20250305" }`): this produces a malformed OpenAI request regardless of this change — the typed tool is stripped but the `tool_choice` is translated to a named function choice. This pre-existing edge case is not made worse by this change and is out of scope.

### handler.ts changes (messages route)

The `response` variable is declared with `let` at the outer scope so it can be assigned in either branch. The web search branch declares `openAIPayload` with `let` so the model-switch guard (Section 3) can reassign it.

```typescript
// Before
if (isWebSearchEnabled() && (await detectWebSearchIntent(anthropicPayload))) {
  const cleanedPayload = stripWebSearchTypedTools(anthropicPayload)
  const openAIPayload = prepareWebSearchPayload(translateToOpenAI(cleanedPayload))
  response = await webSearchInterceptor(openAIPayload)
} else {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  response = await createChatCompletions(openAIPayload)
}

// After
if (isWebSearchEnabled()) {
  let openAIPayload = prepareWebSearchPayload(translateToOpenAI(anthropicPayload))
  // model-switch guard inserted here (see Section 3)
  consola.debug("Translated OpenAI request payload (web search):", JSON.stringify(openAIPayload))
  response = await webSearchInterceptor(openAIPayload)
} else {
  let openAIPayload = translateToOpenAI(anthropicPayload)
  // model-switch guard inserted here (see Section 3)
  consola.debug("Translated OpenAI request payload:", JSON.stringify(openAIPayload))
  response = await createChatCompletions(openAIPayload)
}
```

The `consola.debug` calls are placed **after** the model-switch guard so they log the final payload (including any model change). Note: the current handler has these debug calls at the end of each branch in the same position — they are retained, not removed.

---

## Section 2: Fix Streaming in webSearchInterceptor

### The problem

`webSearchInterceptor` currently forces `stream: false` on the first pass unconditionally:

```typescript
const firstPassPayload: ChatCompletionsPayload = { ...payload, stream: false }
```

When Copilot doesn't call the web search tool (`finish_reason !== "tool_calls"`), the interceptor returns `firstResponse` — which was fetched non-streaming. If the client requested streaming, they get a non-streaming response. This is a silent regression introduced by always routing through the interceptor.

### The fix

Change the interceptor to use the **client's original `stream` flag on the first pass**. If Copilot doesn't call the tool, the streaming response is returned directly as-is. If Copilot does call the tool, the first pass response is a non-streaming response (used to extract the tool call arguments), so the first pass must be forced non-streaming **only when the response will be consumed as data** (i.e. only when Copilot calls the tool).

This requires two passes through the first-pass logic:

**Option A (recommended): Two-step first pass**
1. Always send first pass with `stream: false` (non-streaming) to inspect `finish_reason`
2. If `finish_reason !== "tool_calls"` → **re-issue** the request with the original `stream` flag and return that response
3. If `finish_reason === "tool_calls"` → proceed with tool execution and second pass as before

This adds one extra Copilot call only when the client requests streaming and Copilot doesn't call the tool (total: 2 calls — one non-streaming inspection + one streaming re-issue). For non-streaming non-search requests, there is zero overhead: 1 call total (the non-streaming inspection is returned directly). This is acceptable because web search is opt-in (requires an API key).

**Option B: Single streaming first pass with tool-call sniffing**
Send first pass with original `stream` flag. If streaming, buffer SSE chunks looking for `finish_reason: tool_calls`. If tool call detected, switch to non-streaming second pass. Complex and fragile — rejected.

### Change to `src/services/web-search/interceptor.ts`

There are **two** early-exit points in the current interceptor that both return `firstResponse` (non-streaming) — both must be updated.

**First early exit** (lines ~55–58, when `finish_reason !== "tool_calls"`):

```typescript
// CURRENT
const choice = firstResponse.choices.at(0)
if (!choice || choice.finish_reason !== "tool_calls" || !choice.message.tool_calls) {
  return firstResponse   // always non-streaming — BUG when client wanted streaming
}
```

**Change to:**

```typescript
// NEW
const choice = firstResponse.choices.at(0)
if (!choice || choice.finish_reason !== "tool_calls" || !choice.message.tool_calls) {
  if (payload.stream) {
    return createChatCompletions(payload)  // re-issue streaming — preserves client's stream flag
  }
  return firstResponse  // non-streaming: return first pass directly (no extra call)
}
```

**Second early exit** (lines ~63–65, when tool_calls were made but none was the web_search tool):

```typescript
// CURRENT
const webSearchCall = choice.message.tool_calls.find(
  (tc) => tc.function.name === WEB_SEARCH_TOOL_NAME,
)
if (!webSearchCall) {
  return firstResponse   // always non-streaming — same streaming BUG
}
```

**Change to:**

```typescript
// NEW
const webSearchCall = choice.message.tool_calls.find(
  (tc) => tc.function.name === WEB_SEARCH_TOOL_NAME,
)
if (!webSearchCall) {
  if (payload.stream) {
    return createChatCompletions(payload)  // re-issue streaming
  }
  return firstResponse
}
```

When `payload.stream` is falsy, `firstResponse` is returned directly — 1 Copilot call total. When `payload.stream` is truthy, a second request is issued with the original payload — 2 Copilot calls total. For actual web search (tool was called): first non-streaming pass + second pass with original stream flag = 2 Copilot calls + 1 Tavily call (unchanged).

### `tool_choice: "none"` behaviour

When the client sends `tool_choice: "none"`, the first pass non-streaming inspection call will return `finish_reason: "stop"` (Copilot won't call any tool). The interceptor then re-issues with original stream flag (if streaming) and returns. Correct behaviour.

---

## Section 3: Context-Aware Model Switching

### New file: `src/lib/model-selector.ts`

Pure function, no side effects, easy to unit test.

```typescript
export interface ModelSelectionResult {
  model: string
  switched: boolean
  reason?: string
}

export function selectModelForTokenCount(
  requestedModelId: string,
  models: ModelsResponse,
  estimatedTokens: number,
): ModelSelectionResult
```

**Logic:**
1. Find the requested model in `models.data` by `id`
2. If model not found → return `{ model: requestedModelId, switched: false }` (can't decide without capability data)
3. Read `capabilities.limits.max_context_window_tokens` (preferred) or `capabilities.limits.max_prompt_tokens` as fallback. If neither is set → return `{ model: requestedModelId, switched: false }`
4. If `estimatedTokens <= contextWindow` → return `{ model: requestedModelId, switched: false }` (within limits)
5. Find the model with the largest `max_context_window_tokens` across all `models.data`. If it is the same as the requested model → return `{ model: requestedModelId, switched: false, reason: "already largest context model" }`
6. Return `{ model: largestContextModel.id, switched: true, reason: "prompt [N] tokens exceeds [requestedModel] context window [M], switching to [newModel] [L]" }`

Note: token estimation uses the original model's tokenizer. If the fallback model uses a different tokenizer the estimate may be slightly off — this is acceptable since the guard is a best-effort heuristic.

### Integration in handler.ts (messages route)

Inserted after `prepareWebSearchPayload`/`translateToOpenAI`, before routing to interceptor or `createChatCompletions`. The `openAIPayload` variable is `let`-scoped (shown in Section 1). The guard is identical in both the web-search and non-web-search branches:

```typescript
// Model-switch guard (inserted in both branches, after openAIPayload is assigned)
// Retain the existing consola.debug log of openAIPayload immediately before this block.
if (state.models) {
  try {
    const modelForCount = state.models.data.find(m => m.id === openAIPayload.model)
    if (modelForCount) {
      const { input: estimatedTokens } = await getTokenCount(openAIPayload, modelForCount)
      const result = selectModelForTokenCount(openAIPayload.model, state.models, estimatedTokens)
      if (result.switched) {
        consola.warn(`Context overflow: ${result.reason}`)
        openAIPayload = { ...openAIPayload, model: result.model }
      }
    }
  } catch {
    consola.debug("Token count estimation failed, skipping model switch")
  }
}
```

For `getTokenCount`, the model object is found as: `state.models.data.find(m => m.id === openAIPayload.model)`. If not found, the try/catch handles the failure gracefully.

### Integration in chat-completions/handler.ts

The `chat-completions/handler.ts` existing handler calls `getTokenCount` with `selectedModel` for logging (lines 29–38). Change `selectedModel` from `const` to `let`, then insert the model-switch guard inside the same try block, after the existing `consola.info` call:

```typescript
// Change: const → let
let selectedModel = state.models?.data.find(
  (model) => model.id === payload.model,
)

try {
  if (selectedModel) {
    const tokenCount = await getTokenCount(payload, selectedModel)
    consola.info("Current token count:", tokenCount)
    // NEW: model-switch guard
    // state.models is non-null here — selectedModel was found from it
    // Use non-null assertion (!) since TypeScript cannot narrow through the optional-chain above
    const result = selectModelForTokenCount(payload.model, state.models!, tokenCount.input)
    if (result.switched) {
      consola.warn(`Context overflow: ${result.reason}`)
      payload = { ...payload, model: result.model }
      // Update selectedModel so max_tokens defaulting below uses the switched model
      selectedModel = state.models!.data.find(m => m.id === result.model) ?? selectedModel
    }
  } else {
    consola.warn("No model selected, skipping token count calculation")
  }
} catch (error) {
  consola.warn("Failed to calculate token count:", error)
}
```

Note: `payload` is already declared with `let` in `chat-completions/handler.ts` (line 21: `let payload = await c.req.json<ChatCompletionsPayload>()`), so reassigning `payload` is valid.

---

## Section 4: Upstream Error Forwarding

See companion spec `2026-03-17-upstream-error-forwarding-design.md`. Both changes from that spec are included in this implementation:

1. Remove premature `consola.error(..., response)` in `create-chat-completions.ts`
2. Forward Copilot's parsed JSON error body directly in `error.ts`

---

## Required New Imports

The following imports must be added to files that don't already have them:

| File | Import to add |
|------|--------------|
| `src/routes/messages/handler.ts` | `import { getTokenCount } from "~/lib/tokenizer"` |
| `src/routes/messages/handler.ts` | `import { selectModelForTokenCount } from "~/lib/model-selector"` |
| `src/routes/chat-completions/handler.ts` | `import { selectModelForTokenCount } from "~/lib/model-selector"` |

Remove from `src/routes/messages/handler.ts`:
- `import { detectWebSearchIntent, stripWebSearchTypedTools } from "./web-search-detection"` (entire import, file is deleted)

---

## Files Changed

| File | Change |
|------|--------|
| `src/routes/messages/handler.ts` | Remove detection branch; add model-switch guard; use `let` for `openAIPayload` |
| `src/routes/messages/web-search-detection.ts` | **Deleted** |
| `src/routes/chat-completions/handler.ts` | Add model-switch guard + `selectedModel` update after existing token count |
| `src/services/web-search/interceptor.ts` | Fix streaming: re-issue with original `stream` flag when Copilot doesn't call tool |
| `src/lib/model-selector.ts` | **New** — pure `selectModelForTokenCount` helper |
| `src/lib/error.ts` | Forward upstream JSON errors directly |
| `src/services/copilot/create-chat-completions.ts` | Remove premature `Response {}` log |

## Tests

| File | Change |
|------|--------|
| `tests/model-selector.test.ts` | **New** — unit tests: overflow detection, model switching, no-op within limits, missing model, missing capability data |
| `tests/web-search.test.ts` | Remove detection/preflight tests; add always-on injection tests; add streaming preservation tests for interceptor |

---

## Edge Cases

- **Web search disabled** (`TAVILY_API_KEY` and `BRAVE_API_KEY` both unset): `isWebSearchEnabled()` returns false, flow is identical to current behaviour — no overhead at all.
- **Copilot doesn't call web_search, streaming request**: interceptor fires non-streaming first pass (inspection), then re-issues with `stream: true`. Client gets streaming response. Total: 2 Copilot calls.
- **Copilot doesn't call web_search, non-streaming request**: interceptor fires non-streaming first pass, returns it directly. Total: 1 Copilot call. No overhead vs. direct path.
- **Copilot calls web_search**: first non-streaming pass → tool execution → second pass with original stream flag. Total: 2 Copilot calls + 1 Tavily call (unchanged from current behaviour).
- **`tool_choice: "none"`**: Copilot returns `finish_reason: "stop"` on first pass. Interceptor re-issues with original stream flag if streaming. Web search silently skipped. Correct behaviour.
- **All models have same or smaller context window**: `selectModelForTokenCount` returns `switched: false` — prompt sent as-is, Copilot may reject, but error is now forwarded properly.
- **Token count estimation fails**: try/catch swallows the error, original model is used, no request is broken.
- **Typed web_search tools from client** (e.g. `web_search_20250305`): already stripped by `translateAnthropicToolsToOpenAI` — no behaviour change.

---

## Non-Goals

- No changes to Brave/Tavily provider implementations
- No new CLI flags
- No changes to streaming translation (`stream-translation.ts`)
