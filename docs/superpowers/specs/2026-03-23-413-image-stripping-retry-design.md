# 413 Image Stripping with Progressive Retry

## Problem

When Claude Code sends requests containing base64-encoded screenshots/images, the total request body can exceed GitHub Copilot's size limit. Copilot responds with `413 Request Entity Too Large`. The proxy currently surfaces this as an `api_error` SSE event, which causes Claude Code to stop working entirely rather than compacting and continuing. This is unacceptable for long-running unattended tasks (e.g., executing a large plan file overnight).

## Solution

Intercept 413 errors inside the proxy and progressively strip images from the conversation history before retrying. If stripping all images still isn't enough, trigger Claude Code's auto-compaction as a final fallback. The model never stops — it either gets a successful response with reduced image context, or compacts and continues.

## Retry Cascade

```
Stage 1: Send original request
  └─ 413? → Stage 2: Strip older images, keep most recent, retry
               └─ 413? → Stage 3: Strip ALL images, retry
                            └─ 413? → Stage 4: Return invalid_request_error → triggers auto-compaction
```

Only 413 errors trigger this cascade. All other HTTP errors (401, 429, 500, etc.) propagate immediately as before.

## Image Stripping Logic

### Where images appear

1. **User message content arrays** — `AnthropicImageBlock` items with `type: "image"`
2. **Tool result content arrays** — `AnthropicToolResultBlock.content` can contain `AnthropicImageBlock` items

Document blocks are already replaced with placeholder text by the translation layer and are not a concern.

### Algorithm: `stripImages(payload, keepLast)`

1. Deep-clone the payload to avoid mutating the original
2. Walk all messages in order, collecting references to every image block (within user message content arrays and tool result content arrays)
3. If `keepLast` is true, exclude the last found image from the removal list
4. Replace each targeted image block with `{ type: "text", text: "[Image removed to reduce request size]" }`
5. Return `{ payload, strippedCount }` — the count lets the caller skip stages when no images exist

### Placement

New file: `src/routes/messages/image-stripping.ts`

Contains:
- `stripImages(payload, keepLast)` — the image removal utility
- `fetchWithImageStripping(anthropicPayload)` — the 413 retry cascade wrapper
- `CompactionNeededError` — custom error class for the final fallback stage

## Integration into Handler

### `fetchWithImageStripping(anthropicPayload)`

Wraps `fetchCopilotResponse` with the 413-aware cascade:

1. Call `fetchCopilotResponse(payload)` — if success, return
2. If 413, call `stripImages(payload, keepLast: true)` — if images were stripped, retry
3. If 413 again, call `stripImages(payload, keepLast: false)` — if more images were stripped, retry
4. If 413 again (or no images existed to strip), throw `CompactionNeededError`

### Non-streaming path (`handleNonStreaming`)

- Replace `fetchCopilotResponse(anthropicPayload)` with `fetchWithImageStripping(anthropicPayload)`
- Catch `CompactionNeededError` and return:
  ```json
  {
    "type": "error",
    "error": {
      "type": "invalid_request_error",
      "message": "Request too large. Conversation context exceeds model limit."
    }
  }
  ```
  with HTTP status 413

### Streaming path (`handleStreaming`)

- Replace `fetchCopilotResponse(anthropicPayload)` inside the existing network retry loop with `fetchWithImageStripping(anthropicPayload)`
- The existing network retry loop handles transient connection errors; 413 retries happen inside `fetchWithImageStripping`
- Catch `CompactionNeededError` and emit SSE error event with `type: "invalid_request_error"` (not `"api_error"`)
- Using `invalid_request_error` here is intentional: at this point all images are stripped and the text content itself exceeds limits — compaction is the correct behavior

### Rationale for `invalid_request_error` in final fallback

The existing code deliberately avoids `invalid_request_error` to prevent retry loops. This design only uses it after exhausting all proxy-side remediation (all images stripped). At that point the conversation genuinely needs compaction, and `invalid_request_error` is the correct signal for Claude Code to compact and continue rather than stop.

## Logging

Each stage logs via `consola.warn`:
- `"Request too large (413), retrying with older images stripped (keeping most recent)"`
- `"Still too large (413), retrying with all images stripped"`
- `"Still too large (413) even without images, triggering auto-compaction"`

## Files Changed

### New
- `src/routes/messages/image-stripping.ts` (~80-100 lines)

### Modified
- `src/routes/messages/handler.ts`:
  - Export `fetchCopilotResponse` (currently module-private)
  - Import `fetchWithImageStripping` and `CompactionNeededError`
  - `handleNonStreaming`: swap fetch call, add `CompactionNeededError` catch
  - `handleStreaming`: swap fetch call, add `CompactionNeededError` catch

### Unchanged
- `src/lib/error.ts`
- `src/routes/messages/non-stream-translation.ts`
- `src/routes/messages/stream-translation.ts` (already accepts `errorType` parameter)
- `src/routes/messages/count-tokens-handler.ts`
- `src/services/copilot/create-chat-completions.ts`
