# Upstream Error Forwarding — Design Spec

**Date:** 2026-03-17
**Status:** Approved

## Problem

When Copilot returns an HTTP error (e.g. `model_max_prompt_tokens_exceeded`), the proxy:

1. Logs `Response {}` (the unread `Response` object — useless output)
2. Re-wraps Copilot's JSON error body inside its own envelope, producing double-wrapped stringified JSON:
   ```json
   { "error": { "message": "{\"error\":{\"message\":\"prompt token count...\",\"code\":\"model_max_prompt_tokens_exceeded\"}}", "type": "error" } }
   ```
   The client receives a string where it expects an object. The `code` field is lost. The agent cannot programmatically detect or handle the error type.

## Solution

Two minimal changes, no new abstractions.

### 1. `src/services/copilot/create-chat-completions.ts`

Remove the premature log of the raw `Response` object before its body has been read. The body is read downstream in `forwardError`, so this log is both incorrect (logs `{}`) and redundant.

**Before:**
```ts
consola.error("Failed to create chat completions", response)
throw new HTTPError("Failed to create chat completions", response)
```

**After:**
```ts
throw new HTTPError("Failed to create chat completions", response)
```

### 2. `src/lib/error.ts`

Forward Copilot's parsed JSON error directly when it parses successfully, preserving the upstream error shape and all fields (including `code`). Fall back to the existing envelope only for non-JSON responses.

**Before:**
```ts
const errorText = await error.response.text()
let errorJson: unknown
try {
  errorJson = JSON.parse(errorText)
} catch {
  errorJson = errorText
}
consola.error("HTTP error:", errorJson)
return c.json(
  {
    error: {
      message: errorText,
      type: "error",
    },
  },
  error.response.status as ContentfulStatusCode,
)
```

**After:**
```ts
const errorText = await error.response.text()
let errorJson: unknown
try {
  errorJson = JSON.parse(errorText)
} catch {
  errorJson = null
}
consola.error("HTTP error:", errorJson ?? errorText)

if (errorJson !== null && typeof errorJson === "object") {
  return c.json(errorJson as Record<string, unknown>, error.response.status as ContentfulStatusCode)
}
return c.json(
  { error: { message: errorText, type: "upstream_error" } },
  error.response.status as ContentfulStatusCode,
)
```

## Result

When Copilot returns:
```json
{ "error": { "message": "prompt token count of 55059 exceeds the limit of 12288", "code": "model_max_prompt_tokens_exceeded" } }
```

The client now receives exactly that — structured JSON with the `code` field intact — enabling programmatic error handling in the agent.

## Scope

- 2 files modified
- ~8 lines changed
- No new files, no new tests, no new abstractions
- Existing error handling contract unchanged for non-JSON upstream errors
