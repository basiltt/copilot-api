# Tool Parity for copilot-api

**Date:** 2026-03-16
**Status:** Approved
**Scope:** Full tool parity for the Anthropic ↔ OpenAI translation layer in copilot-api, targeting Claude Code v2.1.76 (March 2026)

---

## Background

copilot-api is a reverse-engineered proxy that exposes GitHub Copilot as an OpenAI-compatible and Anthropic-compatible HTTP server. The Anthropic translation layer (`src/routes/messages/`) translates Anthropic Messages API requests to OpenAI format and back.

The translation layer was built against an earlier subset of the Anthropic API. As of Claude Code v2.1.76, multiple gaps exist that cause silent data loss, runtime errors, or incorrect behavior.

---

## Research Summary

### How Claude Code v2.1.76 Uses Tools

Claude Code sends all its built-in tools as **custom tools** (with `input_schema`) in the `tools` array on every API call. Key findings:

- **Always sent (30 tools):** `Agent`, `Bash`, `Edit`, `EnterPlanMode`, `EnterWorktree`, `ExitPlanMode`, `ExitWorktree`, `Glob`, `Grep`, `LSP`, `NotebookEdit`, `Read`, `Skill`, `TaskOutput`, `TaskStop`, `TodoWrite`, `WebFetch`, `WebSearch`, `Write`, `AskUserQuestion`, `CronCreate`, `CronDelete`, `CronList`, `Brief`
- **Conditionally sent:** `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` (interactive mode), `TeamCreate`, `TeamDelete`, `SendMessage` (agent teams feature)
- **Never sent to model:** `ListMcpResourcesTool`, `ReadMcpResourceTool`, `StructuredOutput` (excluded from API payload by Claude Code itself)
- **Conditional/feature-gated:** `ToolSearch` (requires `ENABLE_TOOL_SEARCH` env var)

### New Tool Definition Fields (v2.1.76)

Claude Code injects extra fields onto tool definitions that the current proxy does not handle:

| Field | When Present | OpenAI Equivalent |
|---|---|---|
| `strict: true` | `structured-outputs-2025-12-15` beta active | `function.strict: true` — **forward** |
| `cache_control` | Prompt caching enabled | None — **strip** |
| `defer_loading: true` | ToolSearch enabled | None — **strip** |
| `input_examples` | `tool-examples-2025-10-29` beta | None — **strip** |
| `eager_input_streaming: true` | Internal flag | None — **strip** |

### New Content Block Types (2025-2026)

| Block Type | Where | Handling |
|---|---|---|
| `document` | User messages (PDFs via Read tool) | Convert to text placeholder |
| `redacted_thinking` | Assistant messages | Strip (no OpenAI equivalent) |
| `thinking` with `signature` | Assistant messages | Strip `signature` field (already handled by collapsing to text) |
| `server_tool_use` | Assistant messages (multi-turn from real Anthropic API) | Serialize to JSON text |
| `web_search_tool_result` | User messages (multi-turn from real Anthropic API) | Serialize to JSON text |
| `tool_result` with array `content` | User messages (computer use screenshots, image output) | Convert image → `image_url`, text → concat, document → placeholder |

### Anthropic-Typed Tools

Non-Claude-Code Anthropic clients may send typed tools (`bash_20250124`, `text_editor_20250728`, `computer_20251124`, `web_search_20250305`, etc.). These have no `input_schema` and cannot be forwarded to Copilot as-is. **Strategy: filter and continue** — strip typed tools from the request, let the call proceed with only custom tools.

---

## Gaps Being Fixed

| # | Gap | Severity |
|---|-----|----------|
| 1 | Anthropic-typed tools (no `input_schema`) crash translation | 🔴 Critical |
| 2 | `tool_result.content` as array drops images/documents | 🔴 High |
| 3 | `strict` field not forwarded to OpenAI | 🟡 Medium |
| 4 | `disable_parallel_tool_use` in `tool_choice` not parsed | 🟡 Medium |
| 5 | `server_tool_use` / `web_search_tool_result` blocks cause runtime errors | 🟡 Medium |
| 6 | `document` content block type unknown | 🟡 Medium |
| 7 | `redacted_thinking` block type unknown | 🟡 Medium |
| 8 | Token count overhead wrong for typed Anthropic tools | 🟡 Medium |
| 9 | `cache_control`, `defer_loading`, `input_examples`, `eager_input_streaming` on tool defs not stripped | 🟢 Low |
| 10 | `thinking` block missing `signature` field in type definition | 🟢 Low |
| 11 | Model name normalization incomplete (haiku-4-5, future variants) | 🟢 Low |

---

## Architecture

### Approach: Surgical in-place fixes (Option A)

Modify 4 existing files with targeted additions. No new files, no new abstractions. Follows existing code patterns.

**Files changed:**
1. `src/routes/messages/anthropic-types.ts` — type definitions
2. `src/routes/messages/non-stream-translation.ts` — request/response translation
3. `src/routes/messages/count-tokens-handler.ts` — token overhead calculation
4. `src/services/copilot/create-chat-completions.ts` — OpenAI `Tool` type

---

## Detailed Design

### File 1: `anthropic-types.ts`

#### 1.1 `AnthropicTool` — Split into union

```typescript
// Custom tool (has input_schema) — what Claude Code sends
export interface AnthropicCustomTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  strict?: boolean
  cache_control?: { type: "ephemeral"; ttl?: number }
  defer_loading?: boolean
  input_examples?: unknown[]
  eager_input_streaming?: boolean
}

// Anthropic-typed tool (versioned type string, no input_schema)
// e.g. bash_20250124, text_editor_20250728, computer_20251124, web_search_20250305
export interface AnthropicTypedTool {
  type: string
  name: string
  [key: string]: unknown
}

export type AnthropicTool = AnthropicCustomTool | AnthropicTypedTool
```

**Detection helper (used in non-stream-translation.ts):**
```typescript
export function isTypedTool(tool: AnthropicTool): tool is AnthropicTypedTool {
  return 'type' in tool
}
```

#### 1.2 `tool_choice` — Add `disable_parallel_tool_use`

```typescript
tool_choice?: {
  type: "auto" | "any" | "tool" | "none"
  name?: string
  disable_parallel_tool_use?: boolean  // ← new
}
```

#### 1.3 `AnthropicToolResultBlock` — Array content

```typescript
export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock>
  is_error?: boolean
}
```

#### 1.4 New `AnthropicDocumentBlock`

```typescript
export interface AnthropicDocumentBlock {
  type: "document"
  source: {
    type: "base64"
    media_type: "application/pdf"
    data: string
  }
  cache_control?: { type: "ephemeral"; ttl?: number }
}
```

#### 1.5 `AnthropicThinkingBlock` — Add `signature`

```typescript
export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string  // ← new
}
```

#### 1.6 New `AnthropicRedactedThinkingBlock`

```typescript
export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}
```

#### 1.7 Server tool blocks (multi-turn passthrough)

```typescript
export interface AnthropicServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content: unknown
}
```

#### 1.8 Update content block union types

```typescript
export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock          // ← new
  | AnthropicToolResultBlock
  | AnthropicWebSearchToolResultBlock  // ← new (multi-turn)

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock  // ← new
  | AnthropicServerToolUseBlock     // ← new (multi-turn)
```

---

### File 2: `non-stream-translation.ts`

#### 2.1 Tool filtering — `translateAnthropicToolsToOpenAI`

```typescript
function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) return undefined

  return anthropicTools
    .filter((tool): tool is AnthropicCustomTool => !isTypedTool(tool))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        // cache_control, defer_loading, input_examples, eager_input_streaming are stripped
      },
    }))
}
```

#### 2.2 Tool result array content — `handleUserMessage`

When `block.content` is an array:
- `text` blocks → concatenate as string (or `image_url` parts if images are present)
- `image` blocks → `image_url` data URI
- `document` blocks → text placeholder `"[Document: PDF content not displayable]"`

```typescript
function mapToolResultContent(
  content: AnthropicToolResultBlock["content"],
): string | Array<ContentPart> | null {
  if (typeof content === "string") return content
  return mapContent(content)  // reuse existing mapContent logic
}
```

In `handleUserMessage`, change:
```typescript
// Before:
content: mapContent(block.content),
// After:
content: mapToolResultContent(block.content),
```

#### 2.3 Document block handling in `mapContent`

Add to the switch statement:
```typescript
case "document": {
  // PDFs cannot be sent to Copilot; include a placeholder
  contentParts.push({
    type: "text",
    text: "[Document: PDF content]",
  })
  break
}
```

When no images are present, add document block filtering to the text-path:
```typescript
const hasImage = content.some((block) => block.type === "image")
if (!hasImage) {
  return content
    .filter((block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
      block.type === "text" || block.type === "thinking",
    )
    // document blocks are skipped (PDF → not representable as text meaningfully)
    .map((block) => (block.type === "text" ? block.text : block.thinking))
    .join("\n\n")
}
```

#### 2.4 `handleAssistantMessage` — new block types

Add filtering for new assistant block types:
- `redacted_thinking` blocks: strip entirely (no OpenAI equivalent, contains opaque binary data)
- `server_tool_use` blocks: serialize as JSON in a text block (preserves multi-turn context)

```typescript
// Existing filter for text blocks stays the same
// Existing filter for thinking blocks stays the same
// New:
const serverToolUseBlocks = message.content.filter(
  (block): block is AnthropicServerToolUseBlock => block.type === "server_tool_use",
)
// Include in allTextContent as JSON:
const allTextContent = [
  ...textBlocks.map((b) => b.text),
  ...thinkingBlocks.map((b) => b.thinking),
  ...serverToolUseBlocks.map((b) => `[Server tool use: ${JSON.stringify(b)}]`),
].join("\n\n")
```

#### 2.5 `handleUserMessage` — web_search_tool_result blocks

```typescript
// web_search_tool_result blocks in user messages → serialize as text
const webSearchResultBlocks = message.content.filter(
  (block): block is AnthropicWebSearchToolResultBlock =>
    block.type === "web_search_tool_result",
)
if (webSearchResultBlocks.length > 0) {
  const text = webSearchResultBlocks
    .map((b) => `[Web search result: ${JSON.stringify(b.content)}]`)
    .join("\n\n")
  newMessages.push({ role: "user", content: text })
}
```

#### 2.6 `translateModelName` — generalized normalization

```typescript
function translateModelName(model: string): string {
  // Normalize claude-{family}-{major}-{minor}[-extra] → claude-{family}-{major}
  // Examples:
  //   claude-sonnet-4-6 → claude-sonnet-4
  //   claude-haiku-4-5  → claude-haiku-4
  //   claude-opus-4-6   → claude-opus-4
  //   claude-opus-4     → claude-opus-4 (unchanged, no minor version)
  return model.replace(/^(claude-[a-z]+-\d+)-\d+.*$/, "$1")
}
```

---

### File 3: `count-tokens-handler.ts`

```typescript
// Anthropic-typed tool token overhead (per Anthropic pricing docs)
const ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD: Record<string, number> = {
  "text_editor_20250728": 700,
  "text_editor_20250429": 700,
  "text_editor_20250124": 700,
  "text_editor_20241022": 700,
  "bash_20250124": 700,
  "bash_20241022": 700,
  // computer_use and web_search: overhead included in beta pricing, not additive
}

// In handleCountTokens, replace the flat +346 logic with per-tool calculation:
if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
  let mcpToolExist = false
  if (anthropicBeta?.startsWith("claude-code")) {
    mcpToolExist = anthropicPayload.tools.some(
      (tool) => !isTypedTool(tool) && tool.name.startsWith("mcp__"),
    )
  }
  if (!mcpToolExist) {
    if (anthropicPayload.model.startsWith("claude")) {
      for (const tool of anthropicPayload.tools) {
        if (isTypedTool(tool)) {
          tokenCount.input += ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD[tool.type] ?? 0
        } else {
          tokenCount.input += 346  // base overhead for custom tools
        }
      }
    } else if (anthropicPayload.model.startsWith("grok")) {
      tokenCount.input += 480  // grok flat overhead unchanged
    }
  }
}
```

---

### File 4: `create-chat-completions.ts`

Add `strict?: boolean` to the `Tool.function` interface:

```typescript
export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean  // ← new: Structured Outputs (forward from Anthropic)
  }
}
```

---

## Data Flow Summary

```
Claude Code → copilot-api proxy → GitHub Copilot

[Anthropic Request]
tools: [
  { name: "Bash", input_schema: {...}, cache_control: {...}, strict: true },  // custom
  { type: "bash_20250124", name: "bash" },  // typed tool (non-CC client)
]
tool_choice: { type: "auto", disable_parallel_tool_use: true }
messages: [
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "x", content: [{ type: "image", ... }] },
    { type: "document", source: { type: "base64", media_type: "application/pdf", ... } }
  ]}
]

↓ translateToOpenAI()

[OpenAI Request]
tools: [
  { type: "function", function: { name: "Bash", parameters: {...}, strict: true } },
  // typed tool "bash_20250124" → stripped
  // cache_control, defer_loading → stripped
]
tool_choice: "auto"  // disable_parallel_tool_use → acknowledged, no OpenAI equivalent
messages: [
  { role: "tool", tool_call_id: "x", content: [image_url: "data:image/..."] },
  { role: "user", content: "[Document: PDF content]" }
]
```

---

## Testing

- Unit tests for `translateAnthropicToolsToOpenAI` with typed tools present
- Unit tests for `mapContent`/`mapToolResultContent` with array tool result content containing images
- Unit tests for `translateModelName` with all claude model variants
- Unit tests for `handleAssistantMessage` with `redacted_thinking` blocks
- Integration smoke test: send a Claude Code-style payload with all new fields, verify it reaches Copilot without error

---

## Out of Scope

- Streaming path changes: no new block types appear in Anthropic streaming chunks that aren't already handled. The `input_json_delta` and `text_delta` handling in `stream-translation.ts` is correct as-is.
- `compaction_delta` streaming event: not yet documented in the official Anthropic API; leave for future work.
- MCP resource tools (`ListMcpResourcesTool`, `ReadMcpResourceTool`): these are never sent by Claude Code to the model and are not in the `tools` array, so no proxy changes needed.
- `pause_turn` stop reason: only appears from Anthropic server-side tools (web search), which we don't proxy. No change needed.
