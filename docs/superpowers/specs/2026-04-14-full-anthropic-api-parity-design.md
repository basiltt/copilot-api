# Full Anthropic API Parity — Design Spec

**Date:** 2026-04-14
**Status:** Draft (v3 — revised after two critical reviews)

## Problem

The copilot-api proxy's Anthropic translation layer supports core API features (text, image, tool_use, tool_result, thinking, basic streaming) but is missing many newer Anthropic API features introduced through 2025-2026. Claude Code v2.1.107+ sends requests that may include these newer features, causing potential failures or silent data loss when the proxy encounters unknown block types or request fields.

## Goal

Achieve maximum compatibility with the full Anthropic Messages API as documented, so the proxy can transparently handle any request from Claude Code or other Anthropic API clients without errors or data loss.

## Approach

Incremental extension of the existing architecture. The proxy already has a clean pattern: types in `anthropic-types.ts`, translation in `non-stream-translation.ts` and `stream-translation.ts`. We extend these files to cover all missing features.

**Key constraint**: The proxy translates Anthropic format → OpenAI format → Copilot. Many Anthropic-specific features (server tools, citations, cache_control) have no OpenAI equivalent. For these, the strategy is: **accept in types, serialize to text in translation, never error on unknown**.

## Gap Analysis

### Missing Request Payload Fields

| Field | Type | Notes |
|-------|------|-------|
| `output_config` | `{ effort?, format? }` | Reasoning effort + JSON schema output |
| `speed` | `"standard" \| "fast"` | Inference speed mode |
| `cache_control` | `{ type: "ephemeral", ttl? }` | Top-level cache control |
| `container` | `{ skills? }` | Persistent sandboxed environments |
| `mcp_servers` | `Array<MCPServerConfig>` | MCP server connections |
| `context_management` | `object` | Cross-request context control |
| `inference_geo` | `string` | Geographic region selection |

### Missing/Incomplete Content Block Fields

| Block | Missing Field | Notes |
|-------|--------------|-------|
| `AnthropicImageBlock` | `source.type: "url"` | Only `base64` is typed; API also supports URL sources |
| `AnthropicTextBlock` | `citations` | Text blocks can carry citation arrays |
| `AnthropicToolUseBlock` | `cache_control`, `caller` | `caller` indicates which tool initiated the call |
| `AnthropicCustomTool` | `allowed_callers` | Restricts which callers can invoke a tool |

### Missing User Content Block Types

| Block Type | Description |
|------------|-------------|
| `search_result` | Grounding with search results (`content`, `source`, `title`) |
| `container_upload` | Sandbox file uploads (`file_id`) |

### Missing Assistant Content Block Types (multi-turn pass-through)

These appear in conversation history when clients replay Anthropic API responses. They can also appear in **user messages** when clients forward prior assistant results.

| Block Type | Description |
|------------|-------------|
| `web_fetch_tool_result` | Web fetch server tool results |
| `code_execution_tool_result` | Python code execution results |
| `bash_code_execution_tool_result` | Bash code execution results |
| `text_editor_code_execution_tool_result` | Text editor execution results |
| `tool_search_tool_result` | Tool search BM25/regex results |

### Missing Streaming Features

| Feature | Description |
|---------|-------------|
| `citations_delta` | Citation appended to current text block |
| `compaction_delta` | Compacted content delta |
| `server_tool_use` in content_block_start | Streaming server tool blocks |
| Fully-formed result blocks in content_block_start | Server tool results arrive complete |

### Stop Reasons — Already Present

`pause_turn` and `refusal` are already in `AnthropicResponse.stop_reason`. `mapOpenAIStopReasonToAnthropic()` maps `content_filter` → `"end_turn"` — intentional and adequate. **No changes needed.**

### Missing Server Tool Types

| Tool Type | Name |
|-----------|------|
| `web_fetch_*` | `web_fetch` |
| `code_execution_*` | `code_execution` |
| `advisor_20260301` | advisor |
| `tool_search_tool_*` | tool search |
| `mcp_toolset` | MCP connector |

### Beta Headers

The proxy does not need to interpret `anthropic-beta` headers — it just needs to not break when they're present. Typed tools carry their version in the `type` field.

---

## Detailed Design

### 1. Type Additions (`anthropic-types.ts`)

#### 1.1 Request Payload

Extend `AnthropicMessagesPayload` with new fields. All are **stripped** during translation — see §2.1.

```typescript
export interface AnthropicMessagesPayload {
  // ... existing fields ...
  output_config?: {
    effort?: "low" | "medium" | "high" | "max"
    format?: { type: "json_schema"; schema: Record<string, unknown> }
  }
  speed?: "standard" | "fast"
  cache_control?: { type: "ephemeral"; ttl?: number }  // number matches existing codebase
  container?: Record<string, unknown>
  mcp_servers?: Array<Record<string, unknown>>
  context_management?: Record<string, unknown>
  inference_geo?: string
}
```

#### 1.2 Existing Type Fixes

**`AnthropicImageBlock`** — add URL source variant:
```typescript
export interface AnthropicImageBlock {
  type: "image"
  source:
    | { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }
    | { type: "url"; url: string }
}
```

> **BREAKING CHANGE**: This makes `source.data` conditional. Files that access `source.data` without checking `source.type === "base64"` will get TypeScript errors. Known impact sites:
> - `attachment-overhead.ts` `estimateImageTokens()` — accesses `block.source.data.length`
> - `image-stripping.ts` `collectToolResultImages()` — accesses `nested.source.data.length`
> - `image-stripping.ts` `collectImageRefs()` — accesses `block.source.data.length`
> - `image-validation.ts` `getInvalidImageReason()` — accesses `block.source.data`
>
> **Fix for all**: Add `if (block.source.type !== "base64") return ...` guard before accessing `.data`. URL-based images have no base64 data to measure/strip/validate, so early-return is correct.

**`AnthropicTextBlock`** — add optional citations:
```typescript
export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: { type: "ephemeral"; ttl?: number }
  citations?: Array<unknown>  // pass-through, not interpreted by proxy
}
```

**`AnthropicToolUseBlock`** — add cache_control and caller:
```typescript
export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: { type: "ephemeral"; ttl?: number }
  caller?: Record<string, unknown>  // pass-through
}
```

**`AnthropicCustomTool`** — add allowed_callers:
```typescript
export interface AnthropicCustomTool {
  // ... existing fields ...
  allowed_callers?: Array<string>
}
```

#### 1.3 New User Content Blocks

```typescript
export interface AnthropicSearchResultBlock {
  type: "search_result"
  source: string        // URL
  title: string
  content: string       // text content of the search result
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

#### 1.4 New Server Tool Result Blocks

These share a common shape. They can appear in **both** user and assistant messages.

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

#### 1.5 Updated Union Types

The helper union **must be exported** so `non-stream-translation.ts` can import it for type narrowing.

```typescript
export type AnthropicServerToolResultBlock =
  | AnthropicWebSearchToolResultBlock
  | AnthropicWebFetchToolResultBlock
  | AnthropicCodeExecutionToolResultBlock
  | AnthropicBashCodeExecutionToolResultBlock
  | AnthropicTextEditorCodeExecutionToolResultBlock
  | AnthropicToolSearchToolResultBlock

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolResultBlock
  | AnthropicSearchResultBlock
  | AnthropicContainerUploadBlock
  | AnthropicServerToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicServerToolUseBlock
  | AnthropicServerToolResultBlock
```

#### 1.6 Stop Reason — Already Complete

No changes needed.

#### 1.7 Updated Streaming Types

Add to `AnthropicContentBlockDeltaEvent.delta`:
```typescript
  | { type: "citations_delta"; citation: unknown }
  | { type: "compaction_delta"; content: unknown }
```

Add to `AnthropicContentBlockStartEvent.content_block`:
```typescript
  | { type: "server_tool_use"; id: string; name: string; input: Record<string, unknown> }
  | AnthropicServerToolResultBlock  // fully-formed, no subsequent deltas
```

These are **type-only changes** in `anthropic-types.ts`. No behavioral changes in `stream-translation.ts`.

### 2. Request Translation (`non-stream-translation.ts`)

#### 2.1 Payload Translation — `translateToOpenAI()`

All new Anthropic-only fields have **no OpenAI equivalent**. `translateToOpenAI()` selectively picks known fields, so unknown fields are automatically excluded — **no code change needed** in this function.

#### 2.2 `handleUserMessage()` — New Block Routing

**Current routing** (3 groups):
1. `tool_result` blocks → extracted, sent as OpenAI `tool` messages
2. `web_search_tool_result` blocks → extracted, serialized as user text
3. Everything else → `otherBlocks` → `mapContent()`

**Change**: Replace group 2 with a broader server tool result filter. **Three code locations must change together**:

```typescript
// NEW: helper function (add at module level)
function isServerToolResultBlock(
  block: AnthropicUserContentBlock,
): block is AnthropicServerToolResultBlock {
  // Matches web_search_tool_result, web_fetch_tool_result, code_execution_tool_result, etc.
  // Excludes plain "tool_result" (which has its own handler).
  return block.type.endsWith("_tool_result") && block.type !== "tool_result"
}

// CHANGE 1: Replace webSearchResultBlocks filter
const serverToolResultBlocks = message.content.filter(isServerToolResultBlock)

// CHANGE 2: Update otherBlocks filter to exclude ALL server tool results
const otherBlocks = message.content.filter(
  (block) => block.type !== "tool_result" && !isServerToolResultBlock(block),
)

// CHANGE 3: Update serialization (replaces current webSearchResultBlocks handler)
if (serverToolResultBlocks.length > 0) {
  const text = serverToolResultBlocks
    .map((b) => `[${b.type}: ${JSON.stringify(b.content)}]`)
    .join("\n\n")
  newMessages.push({ role: "user", content: text })
}
```

The `isServerToolResultBlock` helper returns a **type guard** (`is AnthropicServerToolResultBlock`), so `b.content` is type-safe inside the map.

#### 2.3 `handleAssistantMessage()` — Two Branches Need Updating

**Branch 1** (has tool_use blocks): Currently extracts `textBlocks`, `toolUseBlocks`, `serverToolUseBlocks`. New `*_tool_result` blocks are silently dropped.

**Fix**: Add server tool result extraction with type guard:
```typescript
const serverToolResultBlocks = message.content.filter(
  (block): block is AnthropicServerToolResultBlock =>
    block.type.endsWith("_tool_result") && block.type !== "tool_result",
)

const allTextContent = [
  ...textBlocks.map((b) => b.text),
  ...serverToolUseBlocks.map((b) => `[Server tool use: ${JSON.stringify(b)}]`),
  ...serverToolResultBlocks.map((b) => `[${b.type}: ${JSON.stringify(b.content)}]`),
]
  .filter(Boolean)
  .join("\n\n")
```

Note: The type guard narrows to `AnthropicServerToolResultBlock` so `b.content` is typed.

**Branch 2** (no tool_use blocks): Passes `visibleBlocks` through `mapContent()`. The `visibleBlocks` filter already strips `thinking` and `redacted_thinking`. New block types pass through to `mapContent()` — see §2.4.

#### 2.4 `mapContent()` — Rewrite Both Paths

`mapContent()` has two code paths that BOTH silently drop unknown block types.

**Path A (no images)** — Current code uses a chained `.filter().map().join()` with explicit type checks. Adding new block types to this chain creates type-narrowing issues because the filter predicate doesn't narrow the type.

**Recommended fix**: Rewrite Path A as a for-loop with explicit type handling, matching Path B's pattern:

```typescript
if (!hasImage) {
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
        parts.push(`[Search: ${(block as AnthropicSearchResultBlock).title}]\nSource: ${(block as AnthropicSearchResultBlock).source}\n${(block as AnthropicSearchResultBlock).content}`)
        break
      case "container_upload":
        parts.push(`[Container upload: ${(block as AnthropicContainerUploadBlock).file_id}]`)
        break
      default:
        // Catch-all: server tool results and future unknown types
        if ("content" in block && block.type !== "thinking" && block.type !== "redacted_thinking") {
          parts.push(`[${block.type}: ${JSON.stringify((block as { content: unknown }).content)}]`)
        }
        break
    }
  }
  return parts.filter(Boolean).join("\n\n")
}
```

**Path B (has images)** — Uses a `switch` statement. Add new cases:
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
  if ("content" in block && block.type !== "thinking" && block.type !== "redacted_thinking") {
    contentParts.push({
      type: "text",
      text: `[${block.type}: ${JSON.stringify((block as { content: unknown }).content)}]`,
    })
  }
}
```

**Why type casts**: `mapContent()` receives `Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>`. TypeScript's switch narrowing works on discriminated unions, but the union is large and some cases need explicit casts to access block-specific fields like `title`, `source`, `file_id`. This is consistent with existing code (e.g., the `server_tool_use` case stringifies the whole block).

### 3. Token Counting (`count-tokens-handler.ts`)

Add estimated token overheads for new server tool types. The existing code has a comment: `// computer_use and web_search: overhead included in beta pricing, not additive`. Respect this — do **not** add entries for `computer_*` or `web_search_*`. Only add entries for tool types NOT mentioned in the comment.

```typescript
const ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD: Record<string, number> = {
  // --- existing (from Anthropic pricing docs) ---
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

### 4. Image-Related Files — Type Guard Fixes

Adding the URL source variant to `AnthropicImageBlock` (§1.2) causes compile errors in files that access `source.data` without checking `source.type`. All fixes follow the same pattern: add an early-return guard.

**`attachment-overhead.ts` — `estimateImageTokens()`**:
```typescript
function estimateImageTokens(block: AnthropicImageBlock): number {
  if (block.source.type !== "base64") return MIN_IMAGE_TOKENS  // URL images: use minimum
  return Math.max(MIN_IMAGE_TOKENS, Math.ceil(block.source.data.length / IMAGE_BASE64_CHARS_PER_TOKEN))
}
```

**`image-stripping.ts` — `collectToolResultImages()` and `collectImageRefs()`**:
Add `if (nested.source.type !== "base64") continue` before accessing `nested.source.data.length`. Same for `block.source.data.length` in the main loop. URL-based images have no base64 data to strip.

**`image-validation.ts` — `getInvalidImageReason()`**:
```typescript
if (block.source.type !== "base64") return undefined  // URL images: can't validate dimensions
```

### 5. Attachment Overhead (`attachment-overhead.ts`)

Add token estimates for new content block types by extending `estimateAdditionalAttachmentTokens()`:

```typescript
// Add new helper functions:
function estimateSearchResultTokens(block: AnthropicSearchResultBlock): number {
  return Math.max(500, Math.ceil(block.content.length / 4))
}

// Add to the message iteration loop inside estimateAdditionalAttachmentTokens():
for (const message of payload.messages) {
  if (message.role !== "user") continue
  // ... existing document and image loops ...

  // NEW: search_result blocks
  for (const block of getBlocksOfType(message.content, "search_result")) {
    tokens += estimateSearchResultTokens(block as AnthropicSearchResultBlock)
  }
  // NEW: container_upload blocks (fixed overhead — just a file ID reference)
  for (const block of getBlocksOfType(message.content, "container_upload")) {
    tokens += 100
  }
}
```

The `getBlocksOfType` helper follows the same pattern as existing `getDocumentBlocksFromContent` / `getImageBlocksFromContent`.

### 6. Web Search Detection — NO CHANGE

Do NOT add `web_fetch` to `WEB_SEARCH_TOOL_NAMES`. Web fetch and web search are different tools — adding it would incorrectly route web fetch requests through the Brave Search interceptor pipeline.

### 7. Handler / Utils / Stream Translation — NO CHANGES

- `handler.ts`: Unchanged. `translateToOpenAI()` selectively picks known fields.
- `utils.ts`: Unchanged. Stop reason mapping already correct.
- `stream-translation.ts`: Unchanged. New streaming types are defined in `anthropic-types.ts`.

---

## Files Changed

| File | Changes |
|------|---------|
| `src/routes/messages/anthropic-types.ts` | Add new block types, fix existing types (image URL source, text citations, tool_use cache_control/caller), export `AnthropicServerToolResultBlock` union, extend content block and streaming type unions |
| `src/routes/messages/non-stream-translation.ts` | Add `isServerToolResultBlock()` helper; update `handleUserMessage()` (3 changes: filter, otherBlocks exclusion, serialization); update `handleAssistantMessage()` Branch 1 to include server tool results; rewrite `mapContent()` Path A as for-loop, add cases + default catch-all to Path B |
| `src/routes/messages/count-tokens-handler.ts` | Add typed-tool token overhead estimates for new server tool types (excluding computer/web_search per existing comment) |
| `src/routes/messages/attachment-overhead.ts` | Fix `estimateImageTokens()` for URL-based images; add `search_result` and `container_upload` token estimates |
| `src/routes/messages/image-stripping.ts` | Add `source.type === "base64"` guards before accessing `.data` in `collectToolResultImages()` and `collectImageRefs()` |
| `src/routes/messages/image-validation.ts` | Add `source.type === "base64"` guard in `getInvalidImageReason()` |
| `src/routes/messages/handler.ts` | **No changes** |
| `src/routes/messages/utils.ts` | **No changes** |
| `src/routes/messages/stream-translation.ts` | **No changes** (streaming types are in anthropic-types.ts) |
| `src/routes/messages/web-search-detection.ts` | **No changes** |

## Testing Strategy

### Unit Tests (`tests/anthropic-request.test.ts`)

Add tests following the existing patterns:

1. **`search_result` block in user message** — verify `mapContent()` produces `[Search: {title}]\nSource: {source}\n{content}`
2. **`container_upload` block in user message** — verify produces `[Container upload: {file_id}]`
3. **`web_fetch_tool_result` block in user message** — verify serialized like existing `web_search_tool_result` test
4. **`code_execution_tool_result` in assistant message (Branch 1, with tool calls)** — verify it appears in `allTextContent`
5. **`web_fetch_tool_result` in assistant message (Branch 2, no tool calls)** — verify serialized through `mapContent()` default catch-all
6. **New payload fields** (`output_config`, `speed`, etc.) — verify `translateToOpenAI()` doesn't include them in output
7. **URL-based image source in user message** — verify `mapContent()` handles without crash
8. **`mapContent()` with image + search_result mix** — verify the image path's default case serializes the search_result
9. **`isServerToolResultBlock` matches `web_search_tool_result` but NOT `tool_result`** — unit test the helper

### Compile & Lint

```sh
bun run typecheck   # Verify no type errors from image URL source change
bun test            # Regression test
bun run lint:all    # Lint check
```

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `AnthropicImageBlock` URL source causes compile errors in 3 files | §4 specifies exact guard pattern for each file |
| `mapContent()` Path A rewrite could change behavior for existing block types | The for-loop produces identical output for text/document/server_tool_use. Test existing behavior first. |
| `isServerToolResultBlock` matches future unknown `*_tool_result` types | This is intentional — future-proofing. Unknown types serialize as JSON, which is safe. |
| Token overhead estimates are approximate | Only affects compaction timing, not billing. Over-estimating is safer (triggers compaction earlier). |
| `default` catch-all in `mapContent()` could serialize unexpected blocks | Guards with `"content" in block` and excludes thinking/redacted_thinking. Blocks without `content` are silently skipped. |

## Non-Goals

- Implementing server tool execution (the proxy only translates)
- Supporting Anthropic Batch API or Files API
- Implementing prompt caching semantics
- Adding `reasoning_effort` to `ChatCompletionsPayload` (out of scope)
- Modifying the web search detection/interception pipeline
