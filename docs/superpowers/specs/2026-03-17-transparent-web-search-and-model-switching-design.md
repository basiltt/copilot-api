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

Three coordinated changes:

1. **Always-on web search** — when web search is enabled, inject `web_search` into every request unconditionally; let Copilot decide when to call it
2. **Context-aware model switching** — before sending any request, check if the prompt exceeds the model's context window and auto-switch to the largest-context available model
3. **Upstream error forwarding** — forward Copilot's JSON error body directly (already approved in companion spec `2026-03-17-upstream-error-forwarding-design.md`)

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

Detection is removed entirely. When `TAVILY_API_KEY` or `BRAVE_API_KEY` is set, every request gets `WEB_SEARCH_FUNCTION_TOOL` injected into the OpenAI `tools` array. Copilot calls the tool when it judges the question needs real-time data; otherwise it ignores the tool and answers normally. Zero extra API calls on non-search requests.

### `web-search-detection.ts` — deleted

The entire file is removed. It contained:
- `detectWebSearchIntent()` — no longer needed
- `stripWebSearchTypedTools()` — no longer needed (typed web search tools from clients are still handled by the existing `translateAnthropicToolsToOpenAI` filter, which already strips typed tools)
- `getPreflightModel()` — no longer needed
- `getLastUserMessageText()` — no longer needed

The import of `detectWebSearchIntent` and `stripWebSearchTypedTools` in `handler.ts` is removed.

### handler.ts changes (messages route)

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
  const openAIPayload = prepareWebSearchPayload(translateToOpenAI(anthropicPayload))
  response = await webSearchInterceptor(openAIPayload)
} else {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  response = await createChatCompletions(openAIPayload)
}
```

Note: `stripWebSearchTypedTools` is no longer called. Anthropic typed tools (e.g. `web_search_20250305`) are already stripped by `translateAnthropicToolsToOpenAI` in `non-stream-translation.ts` — that function filters out all typed tools (those without `input_schema`) and only forwards custom tools. No behaviour change for typed-tool payloads.

### webSearchInterceptor — unchanged

The interceptor already handles the "Copilot didn't call web_search" case: if `finish_reason !== "tool_calls"` it returns the first-pass response as-is. So on non-search requests, the interceptor is a transparent pass-through with one non-streaming Copilot call (the first pass). Streaming is preserved — the second pass uses the original `stream` flag.

---

## Section 2: Context-Aware Model Switching

### New file: `src/lib/model-selector.ts`

Pure function, no side effects, easy to unit test.

```typescript
export interface ModelSelectionResult {
  model: string
  switched: boolean
  reason?: string
}

export function selectModelForTokenCount(
  payload: ChatCompletionsPayload,
  models: ModelsResponse,
  estimatedTokens: number,
): ModelSelectionResult
```

**Logic:**
1. Find the requested model in `models.data` by `id`
2. If model not found → return `{ model: payload.model, switched: false }` (can't make a decision without capability data)
3. Read `capabilities.limits.max_context_window_tokens` (preferred) or `capabilities.limits.max_prompt_tokens` as fallback. If neither is set → return `{ model: payload.model, switched: false }`
4. If `estimatedTokens <= contextWindow` → return `{ model: payload.model, switched: false }` (no switch needed)
5. Find the model with the largest `max_context_window_tokens` across all models in `models.data`. If that model is already the requested model → return `{ model: payload.model, switched: false, reason: "already largest context model" }`
6. Return `{ model: largestContextModel.id, switched: true, reason: "prompt [N] exceeds [requested model] context [M], switched to [new model] [L]" }`

### Integration in handler.ts (messages route)

After `translateToOpenAI` / `prepareWebSearchPayload`, before calling `webSearchInterceptor` or `createChatCompletions`:

```typescript
// Estimate token count and switch model if needed
if (state.models) {
  try {
    const selectedModel = state.models.data.find(m => m.id === openAIPayload.model)
    if (selectedModel) {
      const { input: estimatedTokens } = await getTokenCount(openAIPayload, selectedModel)
      const result = selectModelForTokenCount(openAIPayload, state.models, estimatedTokens)
      if (result.switched) {
        consola.warn(`Context overflow: ${result.reason}`)
        openAIPayload = { ...openAIPayload, model: result.model }
      }
    }
  } catch {
    // Token count failure is non-fatal — proceed with original model
    consola.debug("Token count estimation failed, skipping model switch")
  }
}
```

The try/catch ensures a tokenizer failure never breaks a request.

### Also applies to the `/v1/chat/completions` route

The OpenAI-compatible route (`chat-completions/handler.ts`) already calls `getTokenCount` for logging. The same `selectModelForTokenCount` call is added there, after the existing token count calculation, before `createChatCompletions`.

---

## Section 3: Upstream Error Forwarding

See companion spec `2026-03-17-upstream-error-forwarding-design.md`. Both changes from that spec are included in this implementation:

1. Remove premature `consola.error(..., response)` in `create-chat-completions.ts`
2. Forward Copilot's parsed JSON error body directly in `error.ts`

---

## Files Changed

| File | Change |
|------|--------|
| `src/routes/messages/handler.ts` | Remove detection branch; add model-switch guard |
| `src/routes/messages/web-search-detection.ts` | **Deleted** |
| `src/routes/chat-completions/handler.ts` | Add model-switch guard after existing token count |
| `src/lib/model-selector.ts` | **New** — pure `selectModelForTokenCount` helper |
| `src/lib/error.ts` | Forward upstream JSON errors directly |
| `src/services/copilot/create-chat-completions.ts` | Remove premature `Response {}` log |

## Tests

| File | Change |
|------|--------|
| `tests/model-selector.test.ts` | **New** — unit tests: overflow detection, model switching, no-op within limits, missing model, missing capability data |
| `tests/web-search.test.ts` | Remove all detection/preflight tests; add always-on injection tests |

---

## Edge Cases

- **Web search disabled** (`TAVILY_API_KEY` and `BRAVE_API_KEY` both unset): `isWebSearchEnabled()` returns false, flow is identical to current behaviour with no overhead.
- **Copilot doesn't call web_search** (question doesn't need it): `webSearchInterceptor` first pass returns `finish_reason: "stop"`, interceptor returns first-pass response directly. One non-streaming Copilot call overhead on the first pass; streaming uses original flag on second pass.
- **All models have same or smaller context window**: `selectModelForTokenCount` returns `switched: false` with reason — prompt is sent as-is, Copilot may still reject, but the error is now forwarded properly to the client.
- **Token count estimation fails**: try/catch swallows the error, original model is used, no request is broken.
- **Typed web_search tools from client** (e.g. `web_search_20250305`): `translateAnthropicToolsToOpenAI` already strips all typed tools — no change in behaviour.
- **Client sends tool_choice: "none"**: The `prepareWebSearchPayload` injects the tool, but the existing `translateAnthropicToolChoiceToOpenAI` would forward `"none"` — Copilot won't call the tool. Web search silently skipped. This is correct: if the client explicitly says no tools, we respect that.

---

## Non-Goals

- No changes to `webSearchInterceptor` internals
- No changes to streaming translation
- No changes to Brave/Tavily provider implementations
- No new CLI flags
