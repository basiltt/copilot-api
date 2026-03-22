# 413 Image Stripping with Progressive Retry — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Intercept 413 Request Entity Too Large errors from Copilot, progressively strip base64 images from the conversation, retry, and fall back to triggering Claude Code auto-compaction so the model never stops.

**Architecture:** New `image-stripping.ts` module with `stripImages` utility and `fetchWithImageStripping` cascade wrapper. Handler passes `fetchCopilotResponse` as a parameter to avoid circular imports. Cascade: keep-last-image → strip-all-images → throw CompactionNeededError.

**Tech Stack:** TypeScript, Hono, Bun runtime. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-23-413-image-stripping-retry-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/routes/messages/image-stripping.ts` | Create | `CompactionNeededError` class, `stripImages()` internal utility, `fetchWithImageStripping()` cascade wrapper |
| `src/routes/messages/handler.ts` | Modify | Import and wire up `fetchWithImageStripping` + `CompactionNeededError` in both streaming and non-streaming paths |

---

## Chunk 1: Image Stripping Module

### Task 1: Create `CompactionNeededError` and `stripImages` utility

**Files:**
- Create: `src/routes/messages/image-stripping.ts`

- [ ] **Step 1: Create `image-stripping.ts` with `CompactionNeededError` class**

Create the file with the custom error class:

```typescript
import consola from "consola"

import { HTTPError } from "~/lib/error"

import type { AnthropicMessagesPayload } from "./anthropic-types"

/**
 * Thrown when the 413 retry cascade is exhausted (all images stripped,
 * request still too large). Signals the handler to return an
 * `invalid_request_error` that triggers Claude Code auto-compaction.
 */
export class CompactionNeededError extends Error {
  constructor() {
    super("Request too large even after stripping all images")
    this.name = "CompactionNeededError"
  }
}
```

- [ ] **Step 2: Add the `stripImages` function**

Append to `image-stripping.ts`. This walks the Anthropic payload and replaces base64 image blocks with text placeholders:

```typescript
/**
 * Deep-clones the payload and replaces base64 image blocks with text
 * placeholders. When `keepLast` is true and 2+ images exist, the last
 * image (most recent in conversation order) is preserved.
 *
 * Returns the cloned (possibly mutated) payload and the count of images
 * actually replaced.
 */
function stripImages(
  payload: AnthropicMessagesPayload,
  keepLast: boolean,
): { payload: AnthropicMessagesPayload; strippedCount: number } {
  // Deep-clone to avoid mutating the original
  const cloned = structuredClone(payload)

  // Collect references to all base64 image blocks in conversation order.
  // Each entry holds the parent array and the index within that array so
  // we can replace the block in-place after deciding which ones to keep.
  const imageRefs: Array<{ parent: Array<unknown>; index: number }> = []

  for (const message of cloned.messages) {
    if (message.role !== "user") continue
    if (typeof message.content === "string") continue

    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i]

      // AnthropicImageBlock.source.type is always "base64" per current
      // type definitions, so narrowing on type === "image" is sufficient.
      if (block.type === "image") {
        imageRefs.push({
          parent: message.content as Array<unknown>,
          index: i,
        })
      }

      // Walk nested tool_result content arrays
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          const nested = block.content[j]
          if (nested.type === "image") {
            imageRefs.push({
              parent: block.content as Array<unknown>,
              index: j,
            })
          }
        }
      }
    }
  }

  // Determine which images to strip
  const toStrip =
    keepLast && imageRefs.length > 1
      ? imageRefs.slice(0, -1) // keep the last one
      : imageRefs // strip all

  const placeholder = {
    type: "text" as const,
    text: "[Image removed to reduce request size]",
  }

  for (const ref of toStrip) {
    ref.parent[ref.index] = placeholder
  }

  return { payload: cloned, strippedCount: toStrip.length }
}
```

- [ ] **Step 3: Run typecheck to verify no type errors**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run typecheck`
Expected: No errors related to `image-stripping.ts`

- [ ] **Step 4: Run lint to verify code style**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run lint:all`
Expected: No lint errors in `image-stripping.ts`. Fix any issues found.

- [ ] **Step 5: Commit**

```bash
git add src/routes/messages/image-stripping.ts
git commit -m "feat: add stripImages utility and CompactionNeededError class

Implements the image stripping algorithm that walks Anthropic message
payloads and replaces base64 image blocks with text placeholders.
Supports keepLast mode to preserve the most recent image."
```

---

### Task 2: Add `fetchWithImageStripping` cascade wrapper

**Files:**
- Modify: `src/routes/messages/image-stripping.ts`

- [ ] **Step 1: Add the `fetchWithImageStripping` function**

Append to `image-stripping.ts` after the `stripImages` function. This wraps any fetch function with the 413 progressive retry cascade:

```typescript
/**
 * Wraps a Copilot fetch function with progressive 413 retry logic.
 *
 * Cascade:
 *   1. Try original request
 *   2. On 413 with 2+ images: strip older images, keep last, retry
 *   3. On 413: strip ALL images, retry
 *   4. On 413 with no images left: throw CompactionNeededError
 *
 * Non-413 HTTPErrors and non-HTTP errors propagate immediately.
 */
export async function fetchWithImageStripping<T>(
  fetchFn: (payload: AnthropicMessagesPayload) => Promise<T>,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<T> {
  // Stage 1: Try original request
  try {
    return await fetchFn(anthropicPayload)
  } catch (error) {
    if (!is413(error)) throw error
  }

  // Stage 2: Strip older images, keep most recent
  const stage2 = stripImages(anthropicPayload, true)
  if (stage2.strippedCount > 0) {
    consola.warn(
      `Request too large (413), retrying with older images stripped (keeping last image). Removed ${stage2.strippedCount} image(s).`,
    )
    try {
      return await fetchFn(stage2.payload)
    } catch (error) {
      if (!is413(error)) throw error
    }
  }

  // Stage 3: Strip ALL images (always from original payload)
  const stage3 = stripImages(anthropicPayload, false)
  if (stage3.strippedCount > 0) {
    consola.warn(
      `Still too large (413), retrying with all images stripped. Removed ${stage3.strippedCount} image(s).`,
    )
    try {
      return await fetchFn(stage3.payload)
    } catch (error) {
      if (!is413(error)) throw error
    }
  }

  // Stage 4: No images left, request is still too large — trigger compaction
  consola.warn(
    "Still too large (413) even without images, triggering auto-compaction",
  )
  throw new CompactionNeededError()
}

function is413(error: unknown): boolean {
  return error instanceof HTTPError && error.response.status === 413
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run typecheck`
Expected: No type errors

- [ ] **Step 3: Run lint**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run lint:all`
Expected: No lint errors. Fix any issues found.

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/image-stripping.ts
git commit -m "feat: add fetchWithImageStripping 413 retry cascade

Wraps fetchCopilotResponse with progressive 413 handling:
keep-last-image retry → strip-all-images retry → CompactionNeededError.
Accepts fetch function as parameter to avoid circular imports."
```

---

## Chunk 2: Handler Integration

### Task 3: Integrate into `handleNonStreaming`

**Files:**
- Modify: `src/routes/messages/handler.ts`

- [ ] **Step 1: Add imports to handler.ts**

Add the import at the top of `handler.ts`, after the existing `./stream-translation` import:

```typescript
import {
  CompactionNeededError,
  fetchWithImageStripping,
} from "./image-stripping"
```

- [ ] **Step 2: Modify `handleNonStreaming` catch block**

In `handleNonStreaming` (around line 94-125), replace the try/catch block. Change this:

```typescript
  try {
    response = await fetchCopilotResponse(anthropicPayload)
  } catch (error) {
    // Re-throw HTTPErrors so they bubble up to the route-level forwardError
    // handler, which returns the raw Copilot error JSON with the original
    // HTTP status code.  Returning an Anthropic-formatted error with type
    // "invalid_request_error" causes Claude Code to auto-compact and retry
    // in a loop when the prompt exceeds Copilot's token limit — each retry
    // adds more context, making the prompt even larger.
    if (error instanceof HTTPError) throw error

    consola.error("Copilot connection error (fetch-level):", error)
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message:
            error instanceof Error ?
              error.message
            : "An unexpected error occurred.",
        },
      },
      500,
    )
  }
```

To this:

```typescript
  try {
    response = await fetchWithImageStripping(
      fetchCopilotResponse,
      anthropicPayload,
    )
  } catch (error) {
    // 413 cascade exhausted — all images stripped, still too large.
    // Return invalid_request_error to trigger Claude Code auto-compaction.
    // This is safe because images are already gone and compaction will
    // reduce the text content, producing a convergently smaller request.
    if (error instanceof CompactionNeededError) {
      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "Request too large. Conversation context exceeds model limit.",
          },
        },
        413,
      )
    }

    // Re-throw non-413 HTTPErrors so they bubble up to the route-level
    // forwardError handler, which returns the raw Copilot error JSON with
    // the original HTTP status code.
    if (error instanceof HTTPError) throw error

    consola.error("Copilot connection error (fetch-level):", error)
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message:
            error instanceof Error ?
              error.message
            : "An unexpected error occurred.",
        },
      },
      500,
    )
  }
```

- [ ] **Step 3: Run typecheck**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run typecheck`
Expected: No type errors

- [ ] **Step 4: Run lint**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run lint:all`
Expected: No lint errors. Fix any issues found.

- [ ] **Step 5: Commit**

```bash
git add src/routes/messages/handler.ts
git commit -m "feat: integrate 413 image stripping into non-streaming path

handleNonStreaming now uses fetchWithImageStripping to progressively
strip images on 413 errors. Falls back to invalid_request_error to
trigger Claude Code auto-compaction when all images are stripped."
```

---

### Task 4: Integrate into `handleStreaming`

**Files:**
- Modify: `src/routes/messages/handler.ts`

- [ ] **Step 1: Replace `fetchCopilotResponse` in the streaming retry loop**

In `handleStreaming` (around line 177-191), change the `fetchCopilotResponse` call inside the inner `try` of the retry loop. The full inner `try` block changes from:

```typescript
    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      try {
        copilotResponse = await fetchCopilotResponse(anthropicPayload)
        break
      } catch (error) {
        lastError = error
        if (error instanceof HTTPError) throw error
        const isRetriable =
          error instanceof Error && RETRIABLE_ERROR_NAMES.has(error.name)
        if (!isRetriable || attempt === MAX_FETCH_RETRIES) throw error
        consola.warn(
          `Copilot fetch attempt ${attempt}/${MAX_FETCH_RETRIES} failed (${error.message}), retrying…`,
        )
      }
    }
```

To:

```typescript
    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      try {
        copilotResponse = await fetchWithImageStripping(
          fetchCopilotResponse,
          anthropicPayload,
        )
        break
      } catch (error) {
        lastError = error
        if (error instanceof HTTPError) throw error
        const isRetriable =
          error instanceof Error && RETRIABLE_ERROR_NAMES.has(error.name)
        if (!isRetriable || attempt === MAX_FETCH_RETRIES) throw error
        consola.warn(
          `Copilot fetch attempt ${attempt}/${MAX_FETCH_RETRIES} failed (${error.message}), retrying…`,
        )
      }
    }
```

**Error flow after this change:**
- A 413 `HTTPError` from Copilot is caught *inside* `fetchWithImageStripping`, which runs the image-stripping cascade. It never reaches the `if (error instanceof HTTPError) throw error` in the retry loop.
- Non-413 `HTTPError`s (401, 429, 500…) are re-thrown by `fetchWithImageStripping`, hit `if (error instanceof HTTPError) throw error` in the retry loop, and escape to the outer catch — unchanged behavior.
- `CompactionNeededError` (thrown when the cascade is exhausted) is not an `HTTPError`, so it passes the `instanceof HTTPError` check, is not in `RETRIABLE_ERROR_NAMES`, and is thrown to the outer catch on the first attempt — correct behavior.
- Network errors (TimeoutError, ECONNRESET) from inside `fetchWithImageStripping` propagate out, hit the `isRetriable` check, and are retried by the outer loop — unchanged behavior.

- [ ] **Step 2: Add `CompactionNeededError` handling in the outer catch block**

In the outer catch block of `handleStreaming` (around line 213-236), add `CompactionNeededError` handling right after the `pingTimer` cleanup (line 214-215) and before the existing `HTTPError` check. Insert this block:

After:
```typescript
    clearInterval(pingTimer)
    pingTimer = undefined
```

Add:
```typescript

    // 413 cascade exhausted — all images stripped, still too large.
    // Emit invalid_request_error to trigger Claude Code auto-compaction.
    if (error instanceof CompactionNeededError) {
      const errorEvent = translateErrorToAnthropicErrorEvent(
        "Request too large. Conversation context exceeds model limit.",
        "invalid_request_error",
      )
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
      return
    }
```

This goes before the existing:
```typescript
    if (error instanceof HTTPError) {
```

- [ ] **Step 3: Run typecheck**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run typecheck`
Expected: No type errors

- [ ] **Step 4: Run lint**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run lint:all`
Expected: No lint errors. Fix any issues found.

- [ ] **Step 5: Commit**

```bash
git add src/routes/messages/handler.ts
git commit -m "feat: integrate 413 image stripping into streaming path

handleStreaming now uses fetchWithImageStripping inside the network
retry loop. CompactionNeededError triggers invalid_request_error SSE
event for Claude Code auto-compaction."
```

---

### Task 5: Verify build and final checks

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run typecheck`
Expected: Zero errors

- [ ] **Step 2: Run full lint**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run lint:all`
Expected: Zero errors

- [ ] **Step 3: Run build**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run build`
Expected: Build completes successfully, output in `dist/`

- [ ] **Step 4: Run knip (unused exports check)**

Run: `cd c:\Users\ttbasil\Desktop\Projects\PublicProjects\copilot-api && bun run knip`
Expected: No new unused exports from `image-stripping.ts`. Both exports (`CompactionNeededError`, `fetchWithImageStripping`) should be consumed by `handler.ts`. `stripImages` and `is413` are module-private (not exported) and should not be flagged.
