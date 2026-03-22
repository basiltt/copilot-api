# 413 Image Stripping with Progressive Retry

## Problem

When Claude Code sends requests containing base64-encoded screenshots/images, the total request body can exceed GitHub Copilot's size limit. Copilot responds with `413 Request Entity Too Large`. The proxy currently surfaces this as an `api_error` SSE event, which causes Claude Code to stop working entirely rather than compacting and continuing. This is unacceptable for long-running unattended tasks (e.g., executing a large plan file overnight).

## Solution

Intercept 413 errors inside the proxy and progressively strip images from the conversation history before retrying. If stripping all images still isn't enough, trigger Claude Code's auto-compaction as a final fallback. The model never stops — it either gets a successful response with reduced image context, or compacts and continues.

## Translation Boundary

Image stripping operates on the **Anthropic-format payload** (`AnthropicMessagesPayload`) *before* it is passed to `fetchCopilotResponse`. This is correct because `fetchCopilotResponse` internally calls `translateToOpenAI()` which converts `AnthropicImageBlock` (with `source.data` base64) into OpenAI `image_url` content parts. By stripping images from the Anthropic payload before translation, the translated OpenAI payload will naturally be smaller.

## Retry Cascade

```
Stage 1: Send original request
  └─ 413? → Are there 2+ base64 images?
               ├─ yes → Stage 2: Strip older base64 images, keep last, retry
               │          └─ 413? → Stage 3: Strip ALL base64 images, retry
               │                      └─ 413? → Stage 4: throw CompactionNeededError
               └─ no (0-1 images) → Stage 3: Strip ALL base64 images (if any), retry
                                      └─ 413? → Stage 4: throw CompactionNeededError
```

Only 413 errors trigger this cascade. All other HTTP errors (401, 429, 500, etc.) propagate immediately as before.

## Image Stripping Logic

### Where images appear

1. **User message content arrays** — `AnthropicImageBlock` items with `type: "image"`
2. **Tool result content arrays** — `AnthropicToolResultBlock.content` can contain `AnthropicImageBlock` items

Document blocks are already replaced with placeholder text by the translation layer and are not a concern.

### Which images to strip

Only `base64`-sourced images (`source.type === "base64"`) are stripped. These contain the actual image data inline and are the cause of oversized requests. URL-sourced images (if they exist in future payloads) are tiny references and should not be stripped.

### Definition of "most recent image"

"Most recent" means the **last base64 image block encountered** when walking the `messages` array in order (index 0 → last). Within each message, content blocks are walked in array order. Tool result content arrays nested inside user messages are walked inline at their position within the parent message's content array. This produces a single flat ordering of all base64 image blocks across the entire conversation.

### Algorithm: `stripImages(payload, keepLast)`

1. Deep-clone the payload to avoid mutating the original
2. Walk all messages in array order. For each user message, walk its content array in order. When encountering a `tool_result` block with an array content, walk that nested array inline. Collect references to every block where `type === "image"` and `source.type === "base64"`.
3. If `keepLast` is true and more than one image was found, exclude the last collected image from the removal list. If only one image exists, it is kept (nothing to strip).
4. Replace each targeted image block with `{ type: "text", text: "[Image removed to reduce request size]" }`
5. Return `{ payload, strippedCount }` — the count of images actually replaced

### Cascade short-circuit logic

`fetchWithImageStripping` uses `strippedCount` to skip unnecessary stages:
- If Stage 2 `strippedCount === 0` (0 or 1 images total, nothing stripped with `keepLast: true`), skip directly to Stage 3 with the **original** payload
- If Stage 3 `strippedCount === 0` (no base64 images at all), skip directly to Stage 4 (throw `CompactionNeededError`)
- Stage 3 always operates on the **original** payload with `keepLast: false`, not on the Stage 2 result. This is simpler and avoids edge cases around residual state from Stage 2.

### Placement

New file: `src/routes/messages/image-stripping.ts`

Contains:
- `stripImages(payload, keepLast)` — the image removal utility
- `fetchWithImageStripping(fetchFn, anthropicPayload)` — the 413 retry cascade wrapper
- `CompactionNeededError` — custom error class for the final fallback stage

## Dependency Structure

To avoid circular imports between `handler.ts` and `image-stripping.ts`, `fetchWithImageStripping` accepts `fetchCopilotResponse` **as a parameter** rather than importing it:

```typescript
async function fetchWithImageStripping(
  fetchFn: (payload: AnthropicMessagesPayload) => ReturnType<typeof fetchCopilotResponse>,
  anthropicPayload: AnthropicMessagesPayload,
): ReturnType<typeof fetchCopilotResponse>
```

`handler.ts` calls `fetchWithImageStripping(fetchCopilotResponse, anthropicPayload)`. No exports from `handler.ts` are needed. The dependency flows one way: `handler.ts` → `image-stripping.ts`.

## Integration into Handler

### Non-streaming path (`handleNonStreaming`)

- Replace `fetchCopilotResponse(anthropicPayload)` with `fetchWithImageStripping(fetchCopilotResponse, anthropicPayload)`
- Add a **separate** catch clause for `CompactionNeededError` before the existing `HTTPError` re-throw:
  ```typescript
  try {
    response = await fetchWithImageStripping(fetchCopilotResponse, anthropicPayload)
  } catch (error) {
    if (error instanceof CompactionNeededError) {
      return c.json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Request too large. Conversation context exceeds model limit.",
        },
      }, 413)
    }
    if (error instanceof HTTPError) throw error
    // ... existing network error handling
  }
  ```

### Streaming path (`handleStreaming`)

The existing network retry loop in `handleStreaming` immediately re-throws `HTTPError` instances (including 413). `fetchWithImageStripping` catches 413 `HTTPError`s internally before they reach this re-throw. The integration:

- Replace `fetchCopilotResponse(anthropicPayload)` inside the network retry loop with `fetchWithImageStripping(fetchCopilotResponse, anthropicPayload)`
- Inside `fetchWithImageStripping`, a 413 `HTTPError` is caught and triggers the image-stripping cascade. Only non-413 `HTTPError`s are re-thrown (reaching the existing `if (error instanceof HTTPError) throw error` in the retry loop)
- If the cascade is exhausted, `fetchWithImageStripping` throws `CompactionNeededError` (not an `HTTPError`), which propagates out of the retry loop to the outer catch
- Add `CompactionNeededError` handling in the outer catch block:
  ```typescript
  } catch (error) {
    // ... existing cleanup ...
    if (error instanceof CompactionNeededError) {
      const errorEvent = translateErrorToAnthropicErrorEvent(
        "Request too large. Conversation context exceeds model limit.",
        "invalid_request_error",
      )
      await stream.writeSSE({ event: errorEvent.type, data: JSON.stringify(errorEvent) })
      return
    }
    // ... existing HTTPError / generic error handling ...
  }
  ```

### Why `invalid_request_error` is safe in the final fallback

The existing code deliberately avoids `invalid_request_error` to prevent retry loops where Claude Code auto-compacts and retries, each retry adding more context. The concern is valid for *general* errors, but the final fallback here is safe because:

1. By the time we reach Stage 4, all base64 images have been stripped. The request is pure text.
2. Claude Code's compaction reduces the conversation text (summarizes older messages). The compacted request will be smaller.
3. After compaction, the images that caused the original 413 are gone from the conversation history — Claude Code does not re-attach previously removed images. The compacted request will not re-introduce them.
4. If compaction produces a request that is *still* too large, Claude Code will compact again (further reducing text). This converges because text gets shorter with each compaction round.

This is fundamentally different from the scenario the existing comments warn about, where the error itself causes Claude Code to add retry metadata that inflates the prompt.

## Logging

Each stage logs via `consola.warn`:
- `"Request too large (413), retrying with older images stripped (keeping last image)"`
- `"Still too large (413), retrying with all images stripped"`
- `"Still too large (413) even without images, triggering auto-compaction"`

## Files Changed

### New
- `src/routes/messages/image-stripping.ts` (~100-120 lines)

### Modified
- `src/routes/messages/handler.ts`:
  - Import `fetchWithImageStripping` and `CompactionNeededError` from `image-stripping.ts`
  - `handleNonStreaming`: swap fetch call, add `CompactionNeededError` catch before `HTTPError` re-throw
  - `handleStreaming`: swap fetch call inside retry loop, add `CompactionNeededError` catch in outer catch block

### Unchanged
- `src/lib/error.ts`
- `src/routes/messages/non-stream-translation.ts`
- `src/routes/messages/stream-translation.ts` — `translateErrorToAnthropicErrorEvent(message, errorType = "api_error")` already accepts an optional second argument; the `CompactionNeededError` handler passes `"invalid_request_error"` as the second argument, requiring no signature change
- `src/routes/messages/count-tokens-handler.ts`
- `src/services/copilot/create-chat-completions.ts`
