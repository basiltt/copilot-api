# Upstream Error Forwarding — Design Spec

**Date:** 2026-03-17
**Status:** Approved

## Problem

When Copilot returns an HTTP error (e.g. `model_max_prompt_tokens_exceeded`), the proxy:

1. Logs `Response {}` in `create-chat-completions.ts` before the response body has been read — the `Response` object serializes to `{}`, producing useless output in the server log.
2. Re-wraps Copilot's JSON error body inside its own envelope in `forwardError`, producing double-wrapped stringified JSON:
   ```json
   { "error": { "message": "{\"error\":{\"message\":\"prompt token count...\",\"code\":\"model_max_prompt_tokens_exceeded\"}}", "type": "error" } }
   ```
   The client receives a string where it expects an object. The `code` field is lost. The agent cannot programmatically detect or handle the error type.

## Solution

Two minimal changes, no new abstractions.

### 1. `src/services/copilot/create-chat-completions.ts`

Remove the premature log of the raw `Response` object before its body has been read. Body reading happens downstream in `forwardError`, so this log is both incorrect (logs `{}`) and redundant.

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

The current `forwardError` function has two log calls and one response path for `HTTPError`:

```ts
export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)       // ← keep: logs the HTTPError object itself (not the unread Response)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText                      // ← currently stores string; will change to null (see below)
    }
    consola.error("HTTP error:", errorJson)      // ← keep, but update to handle null sentinel
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }
  // ... non-HTTPError path unchanged
}
```

The top-level `consola.error("Error occurred:", error)` logs the `HTTPError` object itself — not the unread `Response` — so it remains useful and is kept unchanged.

**Change:** Forward Copilot's parsed JSON error object directly when it is a non-null object, preserving the upstream error shape and all fields (including `code`). Use `null` as the parse-failure sentinel (rather than the raw string) to cleanly distinguish "parsed successfully" from "parse failed". Fall back to the existing envelope shape for non-JSON responses and for the rare case where upstream returns a valid JSON primitive (number, boolean, string) — these are treated as unstructured and wrapped.

**Before (HTTPError branch only):**
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

**After (HTTPError branch only):**
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
  { error: { message: errorText, type: "error" } },
  error.response.status as ContentfulStatusCode,
)
```

Note: the fallback envelope retains `type: "error"` (unchanged from before) to preserve the existing contract for non-JSON upstream errors.

## Result

When Copilot returns:
```json
{ "error": { "message": "prompt token count of 55059 exceeds the limit of 12288", "code": "model_max_prompt_tokens_exceeded" } }
```

The client now receives exactly that — structured JSON with the `code` field intact — enabling programmatic error handling in the agent.

## Edge Cases

- **Non-JSON upstream response** (e.g. plain text `"Bad Gateway"`): `JSON.parse` throws, sentinel is `null`, falls through to the envelope path — same behavior as before.
- **JSON primitive upstream response** (e.g. `true`, `42`): parses successfully but fails the `typeof === "object"` guard, falls through to the envelope path. This is intentional: JSON primitives are not valid API error responses and are treated as unstructured.
- **Non-`HTTPError` thrown** (e.g. network error, invariant failure): the non-HTTPError path in `forwardError` is unchanged — returns 500 with `error.message`.

## Scope

- 2 files modified (`create-chat-completions.ts`, `error.ts`)
- Net: ~1 line removed, ~5 lines added (~6 lines total touched)
- No new files, no new tests, no new abstractions
- Existing contract for non-JSON upstream errors is preserved (`type: "error"` unchanged)
