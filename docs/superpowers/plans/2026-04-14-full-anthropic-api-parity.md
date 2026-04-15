# Full Anthropic API Parity — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Achieve maximum compatibility with the full Anthropic Messages API so the copilot-api proxy transparently handles any request from Claude Code v2.1.107+ without errors or data loss.

**Architecture:** Incremental extension of the existing translation pipeline. Types are added in `anthropic-types.ts`, translation logic updated in `non-stream-translation.ts`, and guard fixes applied to 4 image-related files. Anthropic-specific features with no OpenAI equivalent are accepted in types and serialized to text during translation.

**Tech Stack:** TypeScript, Hono, Bun runtime. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-14-full-anthropic-api-parity-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/routes/messages/anthropic-types.ts` | Modify | Add 7 request payload fields, fix 4 existing types, add 7 new block interfaces, update 4 union types, add 2 streaming delta types |
| `src/routes/messages/non-stream-translation.ts` | Modify | Add `isServerToolResultBlock()` helper, update `handleUserMessage()` routing, update `handleAssistantMessage()` Branch 1, rewrite `mapContent()` Path A as for-loop, add cases + default to Path B |
| `src/routes/messages/count-tokens-handler.ts` | Modify | Add token overhead entries for new server tool types |
| `src/routes/messages/attachment-overhead.ts` | Modify | Fix `estimateImageTokens()` for URL images, add `search_result` and `container_upload` token estimates |
| `src/routes/messages/image-stripping.ts` | Modify | Add `source.type === "base64"` guards before accessing `.data` |
| `src/routes/messages/image-validation.ts` | Modify | Add `source.type === "base64"` guard in `getInvalidImageReason()` |
| `tests/anthropic-request.test.ts` | Modify | Add 9 test cases covering new block types, translation, and helpers |

**No changes to:** `handler.ts`, `utils.ts`, `stream-translation.ts`, `web-search-detection.ts`

---

## Chunk 1: Type System Foundation

### Task 1: Extend `AnthropicMessagesPayload` with New Request Fields

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts:3-27`

- [ ] **Step 1: Add 7 new optional fields to `AnthropicMessagesPayload`**

Add after the existing `service_tier` field (line 26):

```typescript
export interface AnthropicMessagesPayload {
  // ... existing fields through service_tier ...
  output_config?: {
    effort?: "low" | "medium" | "high" | "max"
    format?: { type: "json_schema"; schema: Record<string, unknown> }
  }
  speed?: "standard" | "fast"
  cache_control?: { type: "ephemeral"; ttl?: number }
  container?: Record<string, unknown>
  mcp_servers?: Array<Record<string, unknown>>
  context_management?: Record<string, unknown>
  inference_geo?: string
}
```

All fields are optional and have no OpenAI equivalent. `translateToOpenAI()` selectively picks known fields, so these are automatically excluded — no translation code changes needed.

- [ ] **Step 2: Run typecheck to verify no regressions**

Run: `bun run typecheck`
Expected: PASS (new optional fields don't break existing code)

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/anthropic-types.ts
git commit -m "feat: add new Anthropic request payload fields (output_config, speed, cache_control, container, mcp_servers, context_management, inference_geo)"
```

---

### Task 2: Fix `AnthropicImageBlock` — Add URL Source Variant

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts:49-56`

- [ ] **Step 1: Update `AnthropicImageBlock` source to be a discriminated union**

Replace the current source type (line 51-55):

```typescript
export interface AnthropicImageBlock {
  type: "image"
  source:
    | { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }
    | { type: "url"; url: string }
}
```

> **WARNING**: This is a breaking change. Code that accesses `block.source.data` or `block.source.media_type` without checking `source.type === "base64"` will get TypeScript errors. The fixes for those files are in Tasks 7-10 (Chunk 2: image guard fixes). Do NOT run typecheck until Task 10 is complete.

- [ ] **Step 2: Commit (typecheck deferred to after Task 10)**

> **Note on compile safety**: This commit introduces type errors that are resolved by Tasks 7-10. If you prefer every commit to be compilable, defer this commit and squash it with Task 10's commit instead.

```bash
git add src/routes/messages/anthropic-types.ts
git commit -m "feat: add URL source variant to AnthropicImageBlock"
```

---

### Task 3: Fix Existing Type Fields — Text Citations, Tool Use, Custom Tool

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts:29-33` (AnthropicTextBlock)
- Modify: `src/routes/messages/anthropic-types.ts:80-85` (AnthropicToolUseBlock)
- Modify: `src/routes/messages/anthropic-types.ts:143-152` (AnthropicCustomTool)

- [ ] **Step 1: Add `citations` to `AnthropicTextBlock`**

```typescript
export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: { type: "ephemeral"; ttl?: number }
  citations?: Array<unknown>  // pass-through, not interpreted by proxy
}
```

The current `AnthropicTextBlock` has `cache_control` but does NOT have `citations`. Add the `citations` field.

- [ ] **Step 2: Add `cache_control` and `caller` to `AnthropicToolUseBlock`**

```typescript
export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: { type: "ephemeral"; ttl?: number }
  caller?: Record<string, unknown>
}
```

- [ ] **Step 3: Add `allowed_callers` to `AnthropicCustomTool`**

```typescript
export interface AnthropicCustomTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  strict?: boolean
  cache_control?: { type: "ephemeral"; ttl?: number }
  defer_loading?: boolean
  input_examples?: Array<unknown>
  eager_input_streaming?: boolean
  allowed_callers?: Array<string>
}
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/anthropic-types.ts
git commit -m "feat: add citations, cache_control, caller, and allowed_callers to existing Anthropic types"
```

---

### Task 4: Add New Content Block Types

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts`

- [ ] **Step 1: Add `AnthropicSearchResultBlock` and `AnthropicContainerUploadBlock`**

Add after `AnthropicWebSearchToolResultBlock` (after line 114):

```typescript
export interface AnthropicSearchResultBlock {
  type: "search_result"
  source: string
  title: string
  content: string
  cache_control?: { type: "ephemeral"; ttl?: number }
  citations?: Array<unknown>
  search_result_index?: number
  start_block_index?: number
  end_block_index?: number
}

export interface AnthropicContainerUploadBlock {
  type: "container_upload"
  file_id: string
  cache_control?: { type: "ephemeral"; ttl?: number }
}
```

- [ ] **Step 2: Add `ServerToolResultBase` and 5 server tool result block interfaces**

Add after the new blocks from Step 1:

```typescript
interface ServerToolResultBase {
  tool_use_id: string
  content: unknown
  cache_control?: { type: "ephemeral"; ttl?: number }
}

export interface AnthropicWebFetchToolResultBlock extends ServerToolResultBase {
  type: "web_fetch_tool_result"
}

export interface AnthropicCodeExecutionToolResultBlock extends ServerToolResultBase {
  type: "code_execution_tool_result"
}

export interface AnthropicBashCodeExecutionToolResultBlock extends ServerToolResultBase {
  type: "bash_code_execution_tool_result"
}

export interface AnthropicTextEditorCodeExecutionToolResultBlock extends ServerToolResultBase {
  type: "text_editor_code_execution_tool_result"
}

export interface AnthropicToolSearchToolResultBlock extends ServerToolResultBase {
  type: "tool_search_tool_result"
}
```

- [ ] **Step 3: Add the exported `AnthropicServerToolResultBlock` union type**

Add after the individual interfaces:

```typescript
export type AnthropicServerToolResultBlock =
  | AnthropicWebSearchToolResultBlock
  | AnthropicWebFetchToolResultBlock
  | AnthropicCodeExecutionToolResultBlock
  | AnthropicBashCodeExecutionToolResultBlock
  | AnthropicTextEditorCodeExecutionToolResultBlock
  | AnthropicToolSearchToolResultBlock
```

This union MUST be exported — `non-stream-translation.ts` imports it for the `isServerToolResultBlock` type guard (Task 11).

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/anthropic-types.ts
git commit -m "feat: add search_result, container_upload, and 5 server tool result block types"
```

---

### Task 5: Update Union Types

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts:116-129`

- [ ] **Step 1: Update `AnthropicUserContentBlock` union**

Replace the current union (lines 116-121):

```typescript
export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolResultBlock
  | AnthropicSearchResultBlock
  | AnthropicContainerUploadBlock
  | AnthropicServerToolResultBlock
```

Note: `AnthropicWebSearchToolResultBlock` is now part of `AnthropicServerToolResultBlock`, so it's included implicitly.

- [ ] **Step 2: Update `AnthropicAssistantContentBlock` union**

Replace the current union (lines 123-129):

```typescript
export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicServerToolUseBlock
  | AnthropicServerToolResultBlock
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/anthropic-types.ts
git commit -m "feat: update content block unions with new types"
```

---

### Task 6: Add Streaming Type Extensions

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts:221-229` (delta types)
- Modify: `src/routes/messages/anthropic-types.ts:210-219` (content_block_start)

- [ ] **Step 1: Add `citations_delta` and `compaction_delta` to `AnthropicContentBlockDeltaEvent`**

Add to the `delta` union (after line 228):

```typescript
export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
    | { type: "citations_delta"; citation: unknown }
    | { type: "compaction_delta"; content: unknown }
}
```

- [ ] **Step 2: Add `server_tool_use` and server tool result types to `AnthropicContentBlockStartEvent`**

Add to the `content_block` union (after line 218):

```typescript
export interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string }
    | { type: "server_tool_use"; id: string; name: string; input: Record<string, unknown> }
    | AnthropicServerToolResultBlock
}
```

These are **type-only changes**. `stream-translation.ts` does NOT need behavioral changes — it translates OpenAI chunks to Anthropic events, and new streaming types only appear in pure Anthropic API responses.

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/anthropic-types.ts
git commit -m "feat: add streaming type extensions (citations_delta, compaction_delta, server blocks)"
```

---

## Chunk 2: Image Guard Fixes

After Task 2 (URL source variant), `source.data` and `source.media_type` are conditionally available. These 4 fixes resolve the resulting compile errors. **All fixes follow the same pattern**: add an early-return guard that skips URL-based images, since they have no base64 data to measure, strip, or validate.

### Task 7: Fix `image-validation.ts` — Guard `getInvalidImageReason()`

**Files:**
- Modify: `src/routes/messages/image-validation.ts:51-68`

- [ ] **Step 1: Add URL source guard at the top of `getInvalidImageReason()`**

Add as the first line inside the function (before line 54):

```typescript
function getInvalidImageReason(
  block: AnthropicImageBlock,
): InvalidImage | undefined {
  if (block.source.type !== "base64") return undefined  // URL images: can't validate dimensions
  // ... rest of function unchanged (source is now narrowed to base64) ...
}
```

The guard narrows `source` to the `base64` variant, so all subsequent accesses to `source.data` and `source.media_type` are type-safe.

- [ ] **Step 2: Run typecheck on this file**

Run: `bun run typecheck`
Expected: `image-validation.ts` errors resolved (other files may still error)

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/image-validation.ts
git commit -m "fix: add base64 source guard in image validation for URL image support"
```

---

### Task 8: Fix `image-stripping.ts` — Guard `collectToolResultImages()` and `collectImageRefs()`

**Files:**
- Modify: `src/routes/messages/image-stripping.ts:107-111` (collectToolResultImages)
- Modify: `src/routes/messages/image-stripping.ts:153-157` (collectImageRefs)

- [ ] **Step 1: Add guard in `collectToolResultImages()`**

At line 107, after `if (nested.type === "image") {`, add a guard before accessing `nested.source.data`:

```typescript
if (nested.type === "image") {
  if (nested.source.type !== "base64") continue  // URL images: no base64 data to strip
  refs.push({
    parent: content as Array<unknown>,
    index: j,
    base64Length: nested.source.data.length,
    messageIndex,
    processed: false,
  })
}
```

- [ ] **Step 2: Add guard in `collectImageRefs()`**

At line 153, after `if (block.type === "image") {`, add a guard:

```typescript
if (block.type === "image") {
  if (block.source.type !== "base64") continue  // URL images: no base64 data to strip
  const ref = {
    parent: message.content as Array<unknown>,
    index: i,
    base64Length: block.source.data.length,
    messageIndex,
    processed: false,
  }
  imageRefs.push(ref)
  pendingRefs.push(ref)
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: `image-stripping.ts` errors resolved

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/image-stripping.ts
git commit -m "fix: add base64 source guards in image stripping for URL image support"
```

---

### Task 9: Fix `attachment-overhead.ts` — Guard `estimateImageTokens()`

**Files:**
- Modify: `src/routes/messages/attachment-overhead.ts:45-50`

- [ ] **Step 1: Add URL source guard at the top of `estimateImageTokens()`**

```typescript
function estimateImageTokens(block: AnthropicImageBlock): number {
  if (block.source.type !== "base64") return MIN_IMAGE_TOKENS  // URL images: use minimum estimate
  return Math.max(
    MIN_IMAGE_TOKENS,
    Math.ceil(block.source.data.length / IMAGE_BASE64_CHARS_PER_TOKEN),
  )
}
```

- [ ] **Step 2: Run typecheck on this file**

Run: `bun run typecheck`
Expected: `attachment-overhead.ts` errors resolved (other files may still error)

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/attachment-overhead.ts
git commit -m "fix: add base64 source guard in attachment overhead for URL image support"
```

---

### Task 10: Fix `non-stream-translation.ts` — Guard `mapContent()` Path B Image Case

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts:425-433`

- [ ] **Step 1: Add URL source handling in the `case "image"` branch of Path B**

The current code at line 429 accesses `block.source.media_type` and `block.source.data` without a guard:

```typescript
case "image": {
  if (block.source.type === "url") {
    contentParts.push({
      type: "image_url",
      image_url: { url: block.source.url },
    })
  } else {
    contentParts.push({
      type: "image_url",
      image_url: {
        url: `data:${block.source.media_type};base64,${block.source.data}`,
      },
    })
  }
  break
}
```

For URL-based images, use the URL directly. For base64, use the existing data URI encoding.

- [ ] **Step 2: Run typecheck — ALL image guard errors should now be resolved**

Run: `bun run typecheck`
Expected: PASS — zero type errors

- [ ] **Step 3: Run existing tests**

Run: `bun test`
Expected: All existing tests pass (no behavioral regressions)

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts
git commit -m "fix: handle URL image source in mapContent Path B"
```

---

## Chunk 3: Translation Logic Updates

### Task 11: Add `isServerToolResultBlock` Helper and Update Imports

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts:13-32` (imports)
- Modify: `src/routes/messages/non-stream-translation.ts` (add helper function)

- [ ] **Step 1: Update imports to include new types**

Add to the import block (around line 13):

```typescript
import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicContainerUploadBlock,     // NEW
  type AnthropicCustomTool,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicRedactedThinkingBlock,
  type AnthropicResponse,
  type AnthropicSearchResultBlock,        // NEW
  type AnthropicServerToolResultBlock,    // NEW
  type AnthropicServerToolUseBlock,
  type AnthropicSystemBlock,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
  isTypedTool,
} from "./anthropic-types"
```

Remove `AnthropicWebSearchToolResultBlock` — after Task 12, nothing references it by name (the filter now uses `isServerToolResultBlock` which operates on the union type).

- [ ] **Step 2: Add `isServerToolResultBlock` helper function**

Add at module level, after the imports and before `translateToOpenAI()` (around line 35):

```typescript
/**
 * Type guard for server tool result blocks. Matches web_search_tool_result,
 * web_fetch_tool_result, code_execution_tool_result, etc.
 * Explicitly excludes plain "tool_result" (which has its own handler).
 */
function isServerToolResultBlock(
  block: AnthropicUserContentBlock | AnthropicAssistantContentBlock,
): block is AnthropicServerToolResultBlock {
  return block.type.endsWith("_tool_result") && block.type !== "tool_result"
}
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts
git commit -m "feat: add isServerToolResultBlock helper and update imports"
```

---

### Task 12: Update `handleUserMessage()` — Replace Web Search Filter with Server Tool Result Filter

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts:107-189`

There are **3 code locations** that must change together. All are inside `handleUserMessage()`.

- [ ] **Step 1: Replace `webSearchResultBlocks` filter with `serverToolResultBlocks`**

Change lines 116-119 from:

```typescript
const webSearchResultBlocks = message.content.filter(
  (block): block is AnthropicWebSearchToolResultBlock =>
    block.type === "web_search_tool_result",
)
```

To:

```typescript
const serverToolResultBlocks = message.content.filter(isServerToolResultBlock)
```

- [ ] **Step 2: Update `otherBlocks` filter to exclude all server tool results**

Change lines 120-124 from:

```typescript
const otherBlocks = message.content.filter(
  (block) =>
    block.type !== "tool_result" && block.type !== "web_search_tool_result",
  // document blocks remain here intentionally — mapContent handles them
)
```

To:

```typescript
const otherBlocks = message.content.filter(
  (block) =>
    block.type !== "tool_result" && !isServerToolResultBlock(block),
  // document blocks remain here intentionally — mapContent handles them
)
```

- [ ] **Step 3: Update serialization block**

Change lines 174-180 from:

```typescript
// Web search result blocks → serialize as user message
if (webSearchResultBlocks.length > 0) {
  const text = webSearchResultBlocks
    .map((b) => `[Web search result: ${JSON.stringify(b.content)}]`)
    .join("\n\n")
  newMessages.push({ role: "user", content: text })
}
```

To:

```typescript
// Server tool result blocks → serialize as user message
if (serverToolResultBlocks.length > 0) {
  const text = serverToolResultBlocks
    .map((b) => `[${b.type}: ${JSON.stringify(b.content)}]`)
    .join("\n\n")
  newMessages.push({ role: "user", content: text })
}
```

Note: This changes the serialization format from `[Web search result: ...]` to `[web_search_tool_result: ...]`. The downstream model receives this as plain text — the exact format doesn't matter, only that the content is preserved.

> **IMPORTANT**: The existing test at `tests/anthropic-request.test.ts:527` asserts `m.content.includes("[Web search result:")`. This test WILL FAIL after this change. Update the test assertion to match the new format: change `"[Web search result:"` to `"web_search_tool_result"`. See Task 17 Step 9 for the replacement test that validates the new routing.

- [ ] **Step 4: Update existing test for changed serialization format**

In `tests/anthropic-request.test.ts`, find the test at line 497 (`"web_search_tool_result block is serialized as user message"`). Update the assertion at line 527:

From:
```typescript
&& m.content.includes("[Web search result:"),
```

To:
```typescript
&& m.content.includes("web_search_tool_result"),
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts tests/anthropic-request.test.ts
git commit -m "feat: replace web search filter with generic server tool result filter in handleUserMessage"
```

---

### Task 13: Update `handleAssistantMessage()` Branch 1 — Include Server Tool Results

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts:191-260`

- [ ] **Step 1: Add server tool result extraction in Branch 1**

After the `serverToolUseBlocks` filter (line 214), add:

```typescript
const serverToolResultBlocks = message.content.filter(isServerToolResultBlock)
```

- [ ] **Step 2: Include server tool results in `allTextContent`**

Update the `allTextContent` array (lines 230-237) to include server tool results:

```typescript
const allTextContent = [
  ...textBlocks.map((b) => b.text),
  ...serverToolUseBlocks.map(
    (b) => `[Server tool use: ${JSON.stringify(b)}]`,
  ),
  ...serverToolResultBlocks.map(
    (b) => `[${b.type}: ${JSON.stringify(b.content)}]`,
  ),
]
  .filter(Boolean)
  .join("\n\n")
```

Branch 2 (no tool_use blocks) passes `visibleBlocks` through `mapContent()`. New block types flow through to `mapContent()` automatically — no changes needed in Branch 2 beyond the `mapContent()` updates in Task 14.

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts
git commit -m "feat: include server tool results in handleAssistantMessage Branch 1"
```

---

### Task 14: Rewrite `mapContent()` — Path A (No Images) and Path B (Has Images)

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts:386-456`

This is the most complex change. `mapContent()` has two code paths that BOTH silently drop unknown block types.

- [ ] **Step 1: Rewrite Path A (no images) as a for-loop**

Replace lines 399-414:

```typescript
return content
  .filter(
    (block) =>
      block.type === "text"
      || block.type === "document"
      || block.type === "server_tool_use",
  )
  .map((block) => {
    if (block.type === "text") return block.text
    if (block.type === "document")
      return "[Document: PDF content not displayable]"
    return `[Server tool use: ${JSON.stringify(block)}]`
  })
  .join("\n\n")
```

With:

```typescript
const parts: string[] = []
for (const block of content) {
  switch (block.type) {
    case "text":
      parts.push(block.text)
      break
    case "document":
      parts.push("[Document: PDF content not displayable]")
      break
    case "server_tool_use":
      parts.push(`[Server tool use: ${JSON.stringify(block)}]`)
      break
    case "search_result":
      parts.push(
        `[Search: ${(block as AnthropicSearchResultBlock).title}]\nSource: ${(block as AnthropicSearchResultBlock).source}\n${(block as AnthropicSearchResultBlock).content}`,
      )
      break
    case "container_upload":
      parts.push(
        `[Container upload: ${(block as AnthropicContainerUploadBlock).file_id}]`,
      )
      break
    default:
      // Catch-all: server tool results and future unknown types
      if (
        "content" in block
        && block.type !== "thinking"
        && block.type !== "redacted_thinking"
      ) {
        parts.push(
          `[${block.type}: ${JSON.stringify((block as { content: unknown }).content)}]`,
        )
      }
      break
  }
}
return parts.filter(Boolean).join("\n\n")
```

**Why type casts**: `mapContent()` receives `Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>`. The combined union is too wide for TypeScript's switch narrowing to resolve block-specific fields like `title`, `source`, `file_id`. The casts are safe because the switch case already narrows the `type` discriminant.

- [ ] **Step 2: Add new cases + default to Path B (has images)**

After the existing `case "server_tool_use"` block (line 449), add before the closing of the switch. **This is additive** — do NOT replace the `case "text"`, `case "image"`, `case "document"`, or `case "server_tool_use"` blocks. Those remain unchanged (including the URL source guard added in Task 10). Only add the new cases below and replace the trailing comments with a `default` case:

```typescript
case "search_result": {
  const sr = block as AnthropicSearchResultBlock
  contentParts.push({
    type: "text",
    text: `[Search: ${sr.title}]\nSource: ${sr.source}\n${sr.content}`,
  })
  break
}
case "container_upload": {
  contentParts.push({
    type: "text",
    text: `[Container upload: ${(block as AnthropicContainerUploadBlock).file_id}]`,
  })
  break
}
default: {
  // Catch-all for server tool results and future unknown types
  if (
    "content" in block
    && block.type !== "thinking"
    && block.type !== "redacted_thinking"
  ) {
    contentParts.push({
      type: "text",
      text: `[${block.type}: ${JSON.stringify((block as { content: unknown }).content)}]`,
    })
  }
  break
}
```

Note: Remove the existing `// redacted_thinking: silently skip` and `// No default` comments at lines 452-453 of the current switch.

- [ ] **Step 3: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: PASS — all type errors resolved, all existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts
git commit -m "feat: rewrite mapContent to handle search_result, container_upload, and unknown block types"
```

---

## Chunk 4: Token Counting and Attachment Overhead

### Task 15: Add Token Overhead for New Server Tool Types

**Files:**
- Modify: `src/routes/messages/count-tokens-handler.ts:27-35`

- [ ] **Step 1: Add new entries to `ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD`**

Extend the existing object (currently lines 27-35). Add new entries AFTER the existing `bash_20241022: 700` entry and the comment about computer_use/web_search:

```typescript
const ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD: Record<string, number> = {
  // --- existing ---
  text_editor_20250728: 700,
  text_editor_20250429: 700,
  text_editor_20250124: 700,
  text_editor_20241022: 700,
  bash_20250124: 700,
  bash_20241022: 700,
  // computer_use and web_search: overhead included in beta pricing, not additive
  // --- new (estimates for compaction heuristic, not billing) ---
  web_fetch_20250910: 500,
  web_fetch_20260209: 500,
  web_fetch_20260309: 500,
  code_execution_20250522: 500,
  code_execution_20250825: 500,
  code_execution_20260120: 500,
  advisor_20260301: 500,
  tool_search_tool_bm25_20251119: 200,
  tool_search_tool_regex_20251119: 200,
  tool_search_tool_bm25: 200,
  tool_search_tool_regex: 200,
  mcp_toolset: 300,
}
```

**Important**: Do NOT add `computer_*` or `web_search_*` entries — the existing comment states their overhead is included in beta pricing. These values are estimates for the compaction heuristic (not billing), so being approximate is fine.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/count-tokens-handler.ts
git commit -m "feat: add token overhead estimates for new server tool types"
```

---

### Task 16: Add Attachment Overhead for New Block Types

**Files:**
- Modify: `src/routes/messages/attachment-overhead.ts`

- [ ] **Step 1: Add import for new types**

Add to the import block at line 1:

```typescript
import type {
  AnthropicImageBlock,
  AnthropicDocumentBlock,
  AnthropicMessagesPayload,
  AnthropicSearchResultBlock,      // NEW
} from "./anthropic-types"
```

Note: Do NOT import `AnthropicContainerUploadBlock` — `getContainerUploadBlocksFromContent` only checks `block.type === "container_upload"` and returns a count, so the type is not needed and importing it would trigger a lint/knip unused-import warning.

- [ ] **Step 2: Add `estimateSearchResultTokens` helper**

Add after `estimateImageTokens` (after line 50):

```typescript
function estimateSearchResultTokens(block: AnthropicSearchResultBlock): number {
  return Math.max(500, Math.ceil(block.content.length / 4))
}
```

- [ ] **Step 3: Add `getSearchResultBlocksFromContent` and `getContainerUploadBlocksFromContent` helpers**

Add after `getImageBlocksFromContent` (after line 100). Follow the same pattern as existing helpers:

```typescript
function getSearchResultBlocksFromContent(
  content: NonNullable<AnthropicMessagesPayload["messages"][number]["content"]>,
): Array<AnthropicSearchResultBlock> {
  if (typeof content === "string") return []

  const results: Array<AnthropicSearchResultBlock> = []

  for (const block of content) {
    if (block.type === "search_result") {
      results.push(block as AnthropicSearchResultBlock)
    }
    // Note: search_result blocks do NOT appear inside tool_result.content
    // (tool_result.content is typed as string | Array<Text|Image|Document>),
    // so we don't need to check nested content here.
  }

  return results
}

function getContainerUploadBlocksFromContent(
  content: NonNullable<AnthropicMessagesPayload["messages"][number]["content"]>,
): number {
  if (typeof content === "string") return 0

  let count = 0
  for (const block of content) {
    if (block.type === "container_upload") count++
  }
  return count
}
```

Note: `getContainerUploadBlocksFromContent` returns a count (not an array) because we only need a fixed-overhead count, not the block contents.

- [ ] **Step 4: Add new block types to `estimateAdditionalAttachmentTokens`**

Inside the `for (const message of payload.messages)` loop (lines 107-119), add after the existing image loop:

```typescript
for (const message of payload.messages) {
  if (message.role !== "user") continue

  for (const document of getDocumentBlocksFromContent(message.content)) {
    tokens += estimateDocumentTokens(document)
  }

  for (const image of getImageBlocksFromContent(message.content)) {
    tokens += estimateImageTokens(image)
  }

  // NEW: search_result blocks
  for (const searchResult of getSearchResultBlocksFromContent(message.content)) {
    tokens += estimateSearchResultTokens(searchResult)
  }

  // NEW: container_upload blocks (fixed overhead — just a file ID reference)
  tokens += getContainerUploadBlocksFromContent(message.content) * 100
}
```

- [ ] **Step 5: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/messages/attachment-overhead.ts
git commit -m "feat: add token overhead estimates for search_result and container_upload blocks"
```

---

## Chunk 5: Tests and Verification

### Task 17: Add Tests for New Block Types and Translation

**Files:**
- Modify: `tests/anthropic-request.test.ts`

All tests follow the existing pattern: construct an `AnthropicMessagesPayload`, call `translateToOpenAI()`, and assert on the resulting OpenAI payload. Add a new `describe` block.

- [ ] **Step 1: Add imports for new types**

Update the import at line 4 to include new types:

```typescript
import {
  isTypedTool,
  type AnthropicMessagesPayload,
  type AnthropicTool,
  type AnthropicSearchResultBlock,
  type AnthropicContainerUploadBlock,
} from "~/routes/messages/anthropic-types"
```

- [ ] **Step 2: Add test — `search_result` block in user message produces formatted text**

```typescript
describe("New Anthropic content block types (API parity)", () => {
  test("search_result block in user message produces formatted text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What did you find?" },
            {
              type: "search_result",
              source: "https://example.com/article",
              title: "Example Article",
              content: "This is the search result content.",
            } as unknown as AnthropicSearchResultBlock & { type: "search_result" },
          ] as AnthropicMessagesPayload["messages"][0]["content"],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    const content = typeof userMsg?.content === "string" ? userMsg.content : ""
    expect(content).toContain("[Search: Example Article]")
    expect(content).toContain("Source: https://example.com/article")
    expect(content).toContain("This is the search result content.")
  })

  test("container_upload block in user message produces placeholder text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "I uploaded a file." },
            {
              type: "container_upload",
              file_id: "file_abc123",
            } as unknown as AnthropicContainerUploadBlock & { type: "container_upload" },
          ] as AnthropicMessagesPayload["messages"][0]["content"],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    const content = typeof userMsg?.content === "string" ? userMsg.content : ""
    expect(content).toContain("[Container upload: file_abc123]")
  })
```

- [ ] **Step 3: Add test — `web_fetch_tool_result` in user message serialized like web_search_tool_result**

```typescript
  test("web_fetch_tool_result block in user message is serialized as user text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Fetch this page." },
        {
          role: "user",
          content: [
            {
              type: "web_fetch_tool_result",
              tool_use_id: "srv_wf_1",
              content: { url: "https://example.com", text: "Page content" },
            } as any,
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const resultMsg = result.messages.find(
      (m) =>
        m.role === "user"
        && typeof m.content === "string"
        && m.content.includes("web_fetch_tool_result"),
    )
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.content).toContain("example.com")
  })
```

- [ ] **Step 4: Add test — `code_execution_tool_result` in assistant message Branch 1**

```typescript
  test("code_execution_tool_result in assistant message with tool calls (Branch 1) appears in text", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Run some code." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here are the results." },
            {
              type: "code_execution_tool_result",
              tool_use_id: "srv_ce_1",
              content: { stdout: "Hello World", exit_code: 0 },
            } as any,
            {
              type: "tool_use",
              id: "call_1",
              name: "Bash",
              input: { command: "echo done" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "done" },
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    expect(assistantMsg?.content).toContain("Here are the results.")
    expect(assistantMsg?.content).toContain("code_execution_tool_result")
    expect(assistantMsg?.content).toContain("Hello World")
    expect(assistantMsg?.tool_calls).toHaveLength(1)
  })
```

- [ ] **Step 5: Add test — `web_fetch_tool_result` in assistant message Branch 2 (no tool calls)**

```typescript
  test("web_fetch_tool_result in assistant message without tool calls (Branch 2) is serialized via mapContent", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Tell me what you fetched." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I fetched a page." },
            {
              type: "web_fetch_tool_result",
              tool_use_id: "srv_wf_2",
              content: { url: "https://example.com", text: "Result text" },
            } as any,
          ],
        },
        { role: "user", content: "Thanks." },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const assistantMsg = result.messages.find((m) => m.role === "assistant")
    const content =
      typeof assistantMsg?.content === "string" ? assistantMsg.content : ""
    expect(content).toContain("I fetched a page.")
    expect(content).toContain("web_fetch_tool_result")
  })
```

- [ ] **Step 6: Add test — new payload fields are NOT passed through to OpenAI**

```typescript
  test("new Anthropic payload fields (output_config, speed, etc.) are not forwarded to OpenAI", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      output_config: { effort: "high" },
      speed: "fast",
      cache_control: { type: "ephemeral" },
      container: { skills: [] },
      mcp_servers: [{ url: "http://localhost:3000" }],
      context_management: {},
      inference_geo: "us",
    }
    const result = translateToOpenAI(anthropicPayload)
    const resultStr = JSON.stringify(result)
    expect(resultStr).not.toContain("output_config")
    expect(resultStr).not.toContain("speed")
    expect(resultStr).not.toContain("cache_control")
    expect(resultStr).not.toContain("container")
    expect(resultStr).not.toContain("mcp_servers")
    expect(resultStr).not.toContain("context_management")
    expect(resultStr).not.toContain("inference_geo")
  })
```

- [ ] **Step 7: Add test — URL-based image source is handled without crash**

```typescript
  test("URL-based image source in user message does not crash", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            {
              type: "image",
              source: { type: "url", url: "https://example.com/image.png" },
            } as any,
          ],
        },
      ],
      max_tokens: 100,
    }
    expect(() => translateToOpenAI(anthropicPayload)).not.toThrow()
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    expect(Array.isArray(userMsg?.content)).toBe(true)
    const parts = userMsg?.content as Array<{ type: string; image_url?: { url: string } }>
    const imagePart = parts.find((p) => p.type === "image_url")
    expect(imagePart?.image_url?.url).toBe("https://example.com/image.png")
  })
```

- [ ] **Step 8: Add test — mapContent with image + search_result mix**

```typescript
  test("mapContent with image + search_result mix handles both correctly", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this." },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
            {
              type: "search_result",
              source: "https://example.com",
              title: "Mixed Test",
              content: "Search result in image context.",
            } as any,
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    const userMsg = result.messages.find((m) => m.role === "user")
    expect(Array.isArray(userMsg?.content)).toBe(true)
    const parts = userMsg?.content as Array<{ type: string; text?: string }>
    expect(parts.some((p) => p.type === "image_url")).toBe(true)
    expect(parts.some((p) => p.type === "text" && p.text?.includes("[Search: Mixed Test]"))).toBe(true)
  })
```

- [ ] **Step 9: Add test — `isServerToolResultBlock` matches correctly**

Note: `isServerToolResultBlock` is a module-private function so we can't import it directly. Instead, test its behavior through `handleUserMessage` — verify that `web_search_tool_result` goes through the server tool result path (not the `otherBlocks` → `mapContent` path) and that plain `tool_result` does NOT go through the server tool result path.

```typescript
  test("web_search_tool_result is routed through server tool result path (not mapContent)", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srv_1",
              content: [{ type: "web_search_result", url: "https://example.com", title: "Test" }],
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateToOpenAI(anthropicPayload)
    // Should produce a user message with serialized content (not a tool message)
    const userMsg = result.messages.find(
      (m) => m.role === "user" && typeof m.content === "string",
    )
    expect(userMsg).toBeDefined()
    expect(userMsg?.content).toContain("web_search_tool_result")
    // Should NOT produce a tool message (tool_result routing is separate)
    const toolMsg = result.messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeUndefined()
  })
}) // close describe block
```

- [ ] **Step 10: Run all tests**

Run: `bun test`
Expected: All tests pass including the 9 new ones

- [ ] **Step 11: Commit tests**

```bash
git add tests/anthropic-request.test.ts
git commit -m "test: add tests for new Anthropic content block types and API parity"
```

---

### Task 18: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: Zero type errors

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Run linter**

Run: `bun run lint:all`
Expected: No lint errors (fix any that appear)

- [ ] **Step 4: Run knip (unused exports check)**

Run: `bun run knip`
Expected: No new unused exports (the new types should be used by translation code)

- [ ] **Step 5: Final commit if any lint fixes were needed**

```bash
git add src/routes/messages/ tests/
git commit -m "chore: lint fixes for API parity changes"
```
