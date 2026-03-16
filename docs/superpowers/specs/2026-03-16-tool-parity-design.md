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

- **Always sent (24 tools):** `Agent`, `Bash`, `Edit`, `EnterPlanMode`, `EnterWorktree`, `ExitPlanMode`, `ExitWorktree`, `Glob`, `Grep`, `LSP`, `NotebookEdit`, `Read`, `Skill`, `TaskOutput`, `TaskStop`, `TodoWrite`, `WebFetch`, `WebSearch`, `Write`, `AskUserQuestion`, `CronCreate`, `CronDelete`, `CronList`, `Brief`
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

The discriminant is the **presence of `input_schema`**: custom tools always have it; typed tools never do. Using `!('input_schema' in tool)` as the typed-tool discriminant is more robust than `'type' in tool`, because a future custom tool definition could hypothetically include a `type` field.

```typescript
export function isTypedTool(tool: AnthropicTool): tool is AnthropicTypedTool {
  return !('input_schema' in tool)
}
```

#### 1.2 `tool_choice` — Add `disable_parallel_tool_use`

`disable_parallel_tool_use` has no OpenAI equivalent and is silently ignored in the translation (not forwarded). It must be parsed in the type so it doesn't cause TypeScript errors, but the `translateAnthropicToolChoiceToOpenAI` function does not need to do anything with it.

```typescript
tool_choice?: {
  type: "auto" | "any" | "tool" | "none"
  name?: string
  disable_parallel_tool_use?: boolean  // ← new; parsed but not forwarded (no OpenAI equivalent)
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

Documents can arrive with different source types (base64 PDF, URL, plain text). The interface uses a wide union to avoid TypeScript errors if non-PDF documents arrive, since the handler emits a placeholder regardless of source type.

```typescript
export interface AnthropicDocumentBlock {
  type: "document"
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string }
    | { type: "text"; data: string }
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

The canonical placeholder string is **`"[Document: PDF content not displayable]"`** — used consistently in all code paths.

The placeholder must appear in **both** the no-image path and the image path. The no-image text path in `mapContent` is the **single authoritative filter** that handles content for both user and assistant messages. It must include `document` (user context) and `server_tool_use` (assistant context) together — these are mutually exclusive by context but the same code path handles both:

```typescript
const hasImage = content.some((block) => block.type === "image")
if (!hasImage) {
  return content
    .filter((block) =>
      block.type === "text"
      || block.type === "thinking"
      || block.type === "document"         // user messages: PDFs → placeholder
      || block.type === "server_tool_use", // assistant messages: server tool → JSON
    )
    .map((block) => {
      if (block.type === "text") return (block as AnthropicTextBlock).text
      if (block.type === "thinking") return (block as AnthropicThinkingBlock).thinking
      if (block.type === "document") return "[Document: PDF content not displayable]"
      return `[Server tool use: ${JSON.stringify(block)}]`  // server_tool_use
    })
    .join("\n\n")
}
```

In the image path, add to the switch statement:
```typescript
case "document": {
  contentParts.push({ type: "text", text: "[Document: PDF content not displayable]" })
  break
}
case "server_tool_use": {
  contentParts.push({ type: "text", text: `[Server tool use: ${JSON.stringify(block)}]` })
  break
}
```

#### 2.4 `handleAssistantMessage` — new block types

**`redacted_thinking` blocks:** Strip before any processing. This only needs to happen in the **no-tool-use branch** (branch 2), because the tool-use branch (branch 1) already naturally excludes `redacted_thinking` through its explicit `textBlocks`, `thinkingBlocks`, and `toolUseBlocks` filters — `redacted_thinking` matches none of them and is already dropped.

```typescript
// Branch 2 only (no custom tool_use blocks):
// Filter out redacted_thinking before calling mapContent
const assistantContent =
  typeof message.content === "string"
    ? message.content
    : message.content.filter((b) => b.type !== "redacted_thinking")
return [{ role: "assistant", content: mapContent(assistantContent) }]
```

**`server_tool_use` blocks:** Handled entirely via `mapContent` (section 2.3 switch case + no-image path). Both branches of `handleAssistantMessage` call `mapContent` at some point, so no branch-specific changes are needed for `server_tool_use`.

**Summary of what the two branches do after changes:**

- **Branch 1** (has `tool_use` blocks): `textBlocks`, `thinkingBlocks`, `toolUseBlocks` explicit filters → `redacted_thinking` already excluded; `server_tool_use` will appear in `allTextContent` via `mapContent` if called, but since Branch 1 constructs content from explicit filtered arrays rather than calling `mapContent`, add `serverToolUseBlocks` filter explicitly:
  ```typescript
  const serverToolUseBlocks = message.content.filter(
    (block): block is AnthropicServerToolUseBlock => block.type === "server_tool_use",
  )
  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
    ...serverToolUseBlocks.map((b) => `[Server tool use: ${JSON.stringify(b)}]`),
  ].filter(Boolean).join("\n\n")
  ```
- **Branch 2** (no `tool_use` blocks): filter `redacted_thinking`, call `mapContent` → `document` and `server_tool_use` handled by updated `mapContent`

#### 2.5 `handleUserMessage` — web_search_tool_result blocks

`web_search_tool_result` blocks must be excluded from `otherBlocks` to avoid double-processing. `document` blocks are **intentionally left in `otherBlocks`** — they route through `mapContent` correctly and should be passed as a user message (they represent a PDF a user is asking about).

```typescript
const toolResultBlocks = message.content.filter(
  (block): block is AnthropicToolResultBlock => block.type === "tool_result",
)
const webSearchResultBlocks = message.content.filter(
  (block): block is AnthropicWebSearchToolResultBlock =>
    block.type === "web_search_tool_result",
)
const otherBlocks = message.content.filter(
  (block) =>
    block.type !== "tool_result" &&
    block.type !== "web_search_tool_result",  // ← new exclusion; document blocks remain
)

// tool_result blocks → role: "tool" messages (existing logic, now using mapToolResultContent)
for (const block of toolResultBlocks) {
  newMessages.push({
    role: "tool",
    tool_call_id: block.tool_use_id,
    content: mapToolResultContent(block.content),
  })
}

// web_search_tool_result blocks → role: "user" message with serialized content
if (webSearchResultBlocks.length > 0) {
  const text = webSearchResultBlocks
    .map((b) => `[Web search result: ${JSON.stringify(b.content)}]`)
    .join("\n\n")
  newMessages.push({ role: "user", content: text })
}

// remaining otherBlocks → existing logic (now handles document blocks via mapContent)
if (otherBlocks.length > 0) {
  newMessages.push({ role: "user", content: mapContent(otherBlocks) })
}
```

#### 2.6 `translateModelName` — generalized normalization

The regex must only apply to claude **generation 4+** models to avoid mangling existing `claude-haiku-3-5` or `claude-sonnet-3-5` model IDs (which use format `claude-family-major-minor` where minor is meaningful and part of the stable name).

```typescript
function translateModelName(model: string): string {
  // Normalize claude-{family}-4-{minor}[-extra] → claude-{family}-4
  // Only applies to generation 4+ where minor version numbers are subagent-build-specific.
  // Known limitation: multi-word family names like claude-sonnet-mini-4 won't match
  // (the [a-z]+ pattern does not cross hyphens), but no such models currently exist.
  //
  // Examples:
  //   claude-sonnet-4-6 → claude-sonnet-4
  //   claude-haiku-4-5  → claude-haiku-4
  //   claude-opus-4-6   → claude-opus-4
  //   claude-sonnet-3-5 → claude-sonnet-3-5 (unchanged — 3.x is stable)
  //   claude-haiku-3-5  → claude-haiku-3-5  (unchanged — 3.x is stable)
  return model.replace(/^(claude-[a-z]+-4)-\d+.*$/, "$1")
}
```

---

### File 3: `count-tokens-handler.ts`

The current code adds `+346` **once** for the entire custom tools array (a flat overhead regardless of how many tools). This existing behavior is **preserved** for custom tools. The only change is: when typed tools are present, add their specific per-tool overhead on top.

```typescript
// Anthropic-typed tool token overhead (per Anthropic pricing docs)
// Only versioned typed tools have specific overhead; custom tools use the existing flat +346
const ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD: Record<string, number> = {
  "text_editor_20250728": 700,
  "text_editor_20250429": 700,
  "text_editor_20250124": 700,
  "text_editor_20241022": 700,
  "bash_20250124": 700,
  "bash_20241022": 700,
  // computer_use and web_search: overhead included in beta pricing, not additive
}

// In handleCountTokens — replace the existing tools block:
if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
  let mcpToolExist = false
  if (anthropicBeta?.startsWith("claude-code")) {
    mcpToolExist = anthropicPayload.tools.some(
      (tool) => !isTypedTool(tool) && tool.name.startsWith("mcp__"),
    )
  }
  if (!mcpToolExist) {
    if (anthropicPayload.model.startsWith("claude")) {
      const hasCustomTools = anthropicPayload.tools.some((t) => !isTypedTool(t))
      const typedTools = anthropicPayload.tools.filter(isTypedTool)

      // Preserve existing flat +346 for custom tools (unchanged behavior)
      if (hasCustomTools) {
        tokenCount.input += 346
      }
      // Add per-typed-tool overhead for Anthropic-typed tools (new)
      for (const tool of typedTools) {
        tokenCount.input += ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD[tool.type] ?? 0
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
  { name: "Bash", input_schema: {...}, cache_control: {...}, strict: true },  // custom tool
  { type: "bash_20250124", name: "bash" },  // typed tool (non-CC Anthropic client)
]
tool_choice: { type: "auto", disable_parallel_tool_use: true }
messages: [
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "x", content: [{ type: "image", source: {...} }] },
    { type: "document", source: { type: "base64", media_type: "application/pdf", ... } }
  ]}
]

↓ translateToOpenAI()

[OpenAI Request]
tools: [
  { type: "function", function: { name: "Bash", parameters: {...}, strict: true } },
  // typed tool "bash_20250124" → stripped (no input_schema, Copilot can't implement)
  // cache_control, defer_loading, input_examples, eager_input_streaming → stripped
]
tool_choice: "auto"
// disable_parallel_tool_use → acknowledged in type, not forwarded (no OpenAI equivalent)
messages: [
  // tool_result with image array → role:"tool" with ContentPart array (vision-capable)
  { role: "tool", tool_call_id: "x", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }] },
  // document block → role:"user" with placeholder text
  { role: "user", content: "[Document: PDF content not displayable]" }
]
```

> **Note on tool role content:** OpenAI tool messages technically accept string content only in the base spec. However, GitHub Copilot's vision-capable models accept `ContentPart` arrays (including `image_url`) in tool messages, matching the pattern used for user messages with images. This is consistent with how the existing `image` block handling works in `handleUserMessage`. If a Copilot model rejects this, the fallback would be to extract only the text parts, but that would lose the image data entirely.

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
