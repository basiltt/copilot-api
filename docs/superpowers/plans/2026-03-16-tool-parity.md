# Tool Parity Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 11 gaps in copilot-api's Anthropic↔OpenAI translation layer to achieve full tool parity with Claude Code v2.1.76.

**Architecture:** Four surgical in-place edits — no new files, no new abstractions. `anthropic-types.ts` gets new interfaces and a discriminator helper; `non-stream-translation.ts` uses them to filter typed tools, handle array tool-result content, and process new content block types; `count-tokens-handler.ts` imports the discriminator and splits token overhead correctly; `create-chat-completions.ts` gets a single `strict?: boolean` field.

**Tech Stack:** Bun runtime, TypeScript, `bun:test` for tests. Run tests with `bun test`. Run type-checking with `bun run typecheck`. Lint with `bun run lint:all`.

---

## File Map

| File | Change |
|------|--------|
| `src/routes/messages/anthropic-types.ts` | Add `AnthropicCustomTool`, `AnthropicTypedTool`, `isTypedTool`; add `AnthropicDocumentBlock`, `AnthropicRedactedThinkingBlock`, `AnthropicServerToolUseBlock`, `AnthropicWebSearchToolResultBlock`; update `AnthropicTool`, `AnthropicThinkingBlock`, `AnthropicToolResultBlock`, content union types, `tool_choice` |
| `src/routes/messages/non-stream-translation.ts` | Update `translateAnthropicToolsToOpenAI`, `mapContent`, `handleUserMessage`, `handleAssistantMessage`, `translateModelName`; add `mapToolResultContent` |
| `src/routes/messages/count-tokens-handler.ts` | Import `isTypedTool`; add `ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD`; replace tools block logic |
| `src/services/copilot/create-chat-completions.ts` | Add `strict?: boolean` to `Tool.function` interface |
| `tests/anthropic-request.test.ts` | Add new test cases for all 11 gaps |

---

## Chunk 1: Type Definitions (`anthropic-types.ts`)

### Task 1: Split `AnthropicTool` into `AnthropicCustomTool` | `AnthropicTypedTool` union with `isTypedTool` helper

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts`
- Test: `tests/anthropic-request.test.ts`

- [ ] **Step 1.1: Write the failing test for typed-tool filtering**

Add to `tests/anthropic-request.test.ts` inside the `"Anthropic to OpenAI translation logic"` describe block:

```typescript
test("should filter out Anthropic typed tools (no input_schema) from tools array", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
    tools: [
      // Custom tool — should be kept
      { name: "Bash", description: "Run shell commands", input_schema: { type: "object", properties: {}, additionalProperties: false } },
      // Anthropic-typed tool — should be filtered
      { type: "bash_20250124", name: "bash" } as unknown as Parameters<typeof translateToOpenAI>[0]["tools"][0],
    ],
  }
  const result = translateToOpenAI(anthropicPayload)
  // Only the custom "Bash" tool survives
  expect(result.tools).toHaveLength(1)
  expect(result.tools?.[0].function.name).toBe("Bash")
})
```

- [ ] **Step 1.2: Run the failing test**

```bash
cd /c/Users/ttbasil/Desktop/Projects/PublicProjects/copilot-api && bun test tests/anthropic-request.test.ts --test-name-pattern "Anthropic typed tools"
```

Expected: FAIL — the current translation returns both tools unfiltered, so `toHaveLength(1)` fails at runtime. The test uses `as unknown as ...` double-cast to bypass TypeScript, so the failure is a runtime assertion error, not a compile error.

- [ ] **Step 1.3: Replace `AnthropicTool` in `anthropic-types.ts`**

In `src/routes/messages/anthropic-types.ts`, replace the existing `AnthropicTool` interface (lines 83–87):

```typescript
// Before:
export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}
```

With:

```typescript
// Custom tool (has input_schema) — what Claude Code and standard clients send
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
// Examples: bash_20250124, text_editor_20250728, computer_20251124, web_search_20250305
export interface AnthropicTypedTool {
  type: string
  name: string
  [key: string]: unknown
}

export type AnthropicTool = AnthropicCustomTool | AnthropicTypedTool

// Discriminant: typed tools never have input_schema; custom tools always do.
// Using presence of input_schema is more robust than checking for type,
// since a future custom tool definition could include a type field.
export function isTypedTool(tool: AnthropicTool): tool is AnthropicTypedTool {
  return !("input_schema" in tool)
}
```

- [ ] **Step 1.4: Run the test to verify it passes**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "Anthropic typed tools"
```

Expected: PASS

- [ ] **Step 1.5: Run typecheck to catch any regressions**

```bash
bun run typecheck
```

Expected: May see errors in `non-stream-translation.ts` where `tool.input_schema` is now on a union type — those are fixed in later tasks. `count-tokens-handler.ts` will not error here because `tool.name` is present on both union members. Note any errors but do not fix them yet.

- [ ] **Step 1.6: Commit**

> Note: The pre-commit hook runs ESLint (lint-staged) on staged files — not `typecheck`. Downstream TypeScript errors in `non-stream-translation.ts` will not block the commit; they are fixed in later tasks.

```bash
git add src/routes/messages/anthropic-types.ts tests/anthropic-request.test.ts
git commit -m "feat: split AnthropicTool into CustomTool|TypedTool union with isTypedTool discriminator"
```

---

### Task 2: Add new content block types to `anthropic-types.ts`

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts`

- [ ] **Step 2.1: Write failing tests for new content block types**

Add to `tests/anthropic-request.test.ts`:

```typescript
test("should handle document blocks in user messages", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What does this PDF say?" },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" },
          },
        ],
      },
    ],
    max_tokens: 100,
  }
  // Should not throw; document block is converted to placeholder text
  expect(() => translateToOpenAI(anthropicPayload)).not.toThrow()
  const result = translateToOpenAI(anthropicPayload)
  expect(isValidChatCompletionRequest(result)).toBe(true)
  // Placeholder text must appear in the message content
  const userMsg = result.messages.find((m) => m.role === "user")
  expect(typeof userMsg?.content).toBe("string")
  expect(userMsg?.content as string).toContain("[Document: PDF content not displayable]")
})

test("should handle redacted_thinking blocks in assistant messages", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [
      { role: "user", content: "Think hard about this." },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "EncryptedThinkingData==" },
          { type: "text", text: "Here is my answer." },
        ],
      },
      { role: "user", content: "Follow up." },
    ],
    max_tokens: 100,
  }
  expect(() => translateToOpenAI(anthropicPayload)).not.toThrow()
  const result = translateToOpenAI(anthropicPayload)
  // The redacted_thinking block is stripped; only the text block survives
  const assistantMsg = result.messages.find((m) => m.role === "assistant")
  expect(assistantMsg?.content).toContain("Here is my answer.")
  // redacted_thinking data must NOT appear as raw base64
  expect(assistantMsg?.content as string).not.toContain("EncryptedThinkingData==")
})
```

- [ ] **Step 2.2: Run the failing tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "document blocks|redacted_thinking"
```

Expected: The `document` test FAILS — `mapContent` silently drops the unknown `document` block type, so `toContain("[Document: PDF content not displayable]")` fails. The `redacted_thinking` test **PASSES** vacuously — the existing `mapContent` filter (`type === "text" || type === "thinking"`) already silently drops `redacted_thinking` blocks, so the output coincidentally matches the desired behavior. The value of adding the `redacted_thinking` type is type-system coverage (enforced by `bun run typecheck`), not new runtime behavior.

- [ ] **Step 2.3a: Update `AnthropicThinkingBlock` to add `signature` field**

Find the existing `AnthropicThinkingBlock` interface in `src/routes/messages/anthropic-types.ts` and replace it:

```typescript
// Before:
export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
}

// After:
export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string  // Used by Claude Code extended thinking
}
```

- [ ] **Step 2.3b: Add new content block interfaces**

After the (now-updated) `AnthropicThinkingBlock`, add the following four new interfaces:

```typescript
// New: redacted thinking (redact-thinking-2026-02-12 beta)
export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}

// New: document block (PDFs sent via Read tool)
// source union covers all Anthropic-documented source types; handler emits a
// placeholder string regardless, so media_type is intentionally wide.
export interface AnthropicDocumentBlock {
  type: "document"
  title?: string
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string }
    | { type: "text"; data: string }
  cache_control?: { type: "ephemeral"; ttl?: number }
}

// New: server-side tool use block in assistant messages
// Appears in multi-turn histories from real Anthropic API with web_search server tool
export interface AnthropicServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

// New: web search tool result block in user messages
// Appears in multi-turn histories from real Anthropic API with web_search server tool
export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content: unknown
}
```

- [ ] **Step 2.4: Update `AnthropicToolResultBlock` content type**

Replace the existing `AnthropicToolResultBlock`:

```typescript
export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock>
  is_error?: boolean
}
```

- [ ] **Step 2.5: Update `tool_choice` to accept `disable_parallel_tool_use`**

In `AnthropicMessagesPayload`, replace the `tool_choice` field:

```typescript
// Before:
tool_choice?: {
  type: "auto" | "any" | "tool" | "none"
  name?: string
}

// After:
tool_choice?: {
  type: "auto" | "any" | "tool" | "none"
  name?: string
  disable_parallel_tool_use?: boolean  // parsed but not forwarded — no OpenAI equivalent
}
```

- [ ] **Step 2.6: Update content block union types**

Replace the existing `AnthropicUserContentBlock` and `AnthropicAssistantContentBlock` type aliases. `AnthropicToolResultBlock` is already in the user union — this update adds `AnthropicDocumentBlock` and `AnthropicWebSearchToolResultBlock` to it, and adds `AnthropicRedactedThinkingBlock` and `AnthropicServerToolUseBlock` to the assistant union:

```typescript
export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolResultBlock
  | AnthropicWebSearchToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicServerToolUseBlock
```

- [ ] **Step 2.7: Run the tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "document blocks|redacted_thinking"
```

Expected: FAIL — the `document` test fails because `mapContent` does not yet produce `"[Document: PDF content not displayable]"` placeholder text (the assertion `toContain("[Document: ...]")` will fail). Check that TypeScript is clean in `anthropic-types.ts`:

```bash
bun run typecheck 2>&1 | head -40
```

The only errors should be in `non-stream-translation.ts` (where `tool.input_schema` and the new union members cause TS errors) — not in `anthropic-types.ts` itself and not in `count-tokens-handler.ts` (which only accesses `tool.name`, present on both union members).

- [ ] **Step 2.8: Commit**

```bash
git add src/routes/messages/anthropic-types.ts tests/anthropic-request.test.ts
git commit -m "feat: add new Anthropic content block types (document, redacted_thinking, server_tool_use, web_search_tool_result)"
```

---

## Chunk 2: OpenAI Tool Type (`create-chat-completions.ts`)

### Task 3: Add `strict` to OpenAI `Tool` interface

**Files:**
- Modify: `src/services/copilot/create-chat-completions.ts`
- Test: `tests/anthropic-request.test.ts`

- [ ] **Step 3.1: Write failing test for `strict` forwarding**

Add to `tests/anthropic-request.test.ts`:

```typescript
test("should forward strict:true from custom tool definitions to OpenAI", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
    tools: [
      {
        name: "getWeather",
        description: "Get weather",
        input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
        strict: true,
      },
    ],
  }
  const result = translateToOpenAI(anthropicPayload)
  expect(result.tools?.[0].function.strict).toBe(true)
})

test("should not add strict field when not provided", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
    tools: [
      {
        name: "getWeather",
        description: "Get weather",
        input_schema: { type: "object", properties: {} },
      },
    ],
  }
  const result = translateToOpenAI(anthropicPayload)
  expect(result.tools?.[0].function.strict).toBeUndefined()
})
```

- [ ] **Step 3.2: Run the failing tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "strict"
```

Expected: FAIL — `result.tools?.[0].function.strict` doesn't exist yet.

- [ ] **Step 3.3: Add `strict` to the `Tool` interface**

In `src/services/copilot/create-chat-completions.ts`, find the `Tool` interface (around line 153) and update:

```typescript
export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean  // Structured Outputs — forwarded from Anthropic custom tool definitions
  }
}
```

- [ ] **Step 3.4: Run the tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "strict"
```

Expected: The first test (`strict: true` → `.toBe(true)`) still FAILS — the translation doesn't forward `strict` yet. The second test (`strict` not provided → `.toBeUndefined()`) **PASSES** vacuously — the field isn't forwarded, so it's `undefined` which satisfies the assertion. Both tests pass after Task 4's translation update.

- [ ] **Step 3.5: Commit the type-only change**

> Note: One strict-forwarding test still fails here — the translation logic is updated in Task 4. Committing with a red test is intentional in this TDD workflow; the pre-commit hook only runs ESLint, not the test suite.

```bash
git add src/services/copilot/create-chat-completions.ts
git commit -m "feat: add strict field to OpenAI Tool.function interface for Structured Outputs"
```

---

## Chunk 3: Translation Functions (`non-stream-translation.ts`)

### Task 4: Update `translateAnthropicToolsToOpenAI` — filter typed tools, forward `strict`, strip extra fields

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts`

- [ ] **Step 4.1: Update imports in `non-stream-translation.ts`**

> **Prerequisite:** Tasks 1 and 2 (Chunk 1) must be committed before this step — the import list includes types added by those tasks.

At the top of `src/routes/messages/non-stream-translation.ts`, replace the existing import block from `"./anthropic-types"` with:

```typescript
import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicCustomTool,
  type AnthropicDocumentBlock,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicRedactedThinkingBlock,
  type AnthropicResponse,
  type AnthropicServerToolUseBlock,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
  type AnthropicWebSearchToolResultBlock,
  isTypedTool,
} from "./anthropic-types"
```

- [ ] **Step 4.2: Replace `translateAnthropicToolsToOpenAI`**

Find the existing `translateAnthropicToolsToOpenAI` function and replace it entirely:

```typescript
function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }

  return anthropicTools
    .filter((tool): tool is AnthropicCustomTool => !isTypedTool(tool))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        // Forward strict for Structured Outputs; strip all other extra fields
        // (cache_control, defer_loading, input_examples, eager_input_streaming)
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }))
}
```

- [ ] **Step 4.3: Run the tests that Task 4 makes pass**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "Anthropic typed tools|forward strict"
```

Expected: All 2 targeted tests PASS. (The `"should not add strict field"` test passed vacuously from Task 3; the `"Anthropic typed tools"` test was failing since Task 1. Both should be green now.)

- [ ] **Step 4.4: Run the full test suite**

```bash
bun test
```

Expected: All existing tests pass; new tests from Tasks 1–3 pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts
git commit -m "feat: filter typed tools and forward strict field in translateAnthropicToolsToOpenAI"
```

---

### Task 5: Update `translateModelName` — generalized claude-4+ normalization

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts`
- Test: `tests/anthropic-request.test.ts`

- [ ] **Step 5.1: Write failing tests for model name normalization**

Add to `tests/anthropic-request.test.ts`:

```typescript
describe("translateModelName normalization", () => {
  // Helper: call translateToOpenAI with just the model and extract the model name
  function getTranslatedModel(model: string): string {
    const result = translateToOpenAI({
      model,
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 10,
    })
    return result.model
  }

  test("normalizes claude-sonnet-4-6 to claude-sonnet-4", () => {
    expect(getTranslatedModel("claude-sonnet-4-6")).toBe("claude-sonnet-4")
  })

  test("normalizes claude-haiku-4-5 to claude-haiku-4 (was missing before)", () => {
    expect(getTranslatedModel("claude-haiku-4-5")).toBe("claude-haiku-4")
  })

  test("normalizes claude-opus-4-6 to claude-opus-4", () => {
    expect(getTranslatedModel("claude-opus-4-6")).toBe("claude-opus-4")
  })

  test("does NOT change claude-sonnet-3-5 (stable 3.x name)", () => {
    expect(getTranslatedModel("claude-sonnet-3-5")).toBe("claude-sonnet-3-5")
  })

  test("does NOT change claude-haiku-3-5 (stable 3.x name)", () => {
    expect(getTranslatedModel("claude-haiku-3-5")).toBe("claude-haiku-3-5")
  })

  test("normalizes long versioned names like claude-sonnet-4-6-20251231", () => {
    expect(getTranslatedModel("claude-sonnet-4-6-20251231")).toBe("claude-sonnet-4")
  })

  test("does NOT change non-claude models", () => {
    expect(getTranslatedModel("gpt-4o")).toBe("gpt-4o")
    expect(getTranslatedModel("grok-2")).toBe("grok-2")
  })
})
```

- [ ] **Step 5.2: Run the failing tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "translateModelName"
```

Expected: The `haiku-4-5` test FAILS; others may pass already.

- [ ] **Step 5.3: Replace `translateModelName` in `non-stream-translation.ts`**

Find the existing `translateModelName` function and **replace it entirely** with:

```typescript
function translateModelName(model: string): string {
  // Normalize claude-{family}-4-{minor}[-extra] → claude-{family}-4
  // Only applies to generation 4+ where minor version numbers are subagent-build-specific.
  // Known limitation: multi-word family names like claude-sonnet-mini-4 won't match
  // ([a-z]+ does not cross hyphens), but no such models currently exist.
  //
  // Test cases:
  //   claude-sonnet-4-6         → claude-sonnet-4   ✓
  //   claude-haiku-4-5          → claude-haiku-4    ✓
  //   claude-opus-4-6           → claude-opus-4     ✓
  //   claude-sonnet-4-6-20251231 → claude-sonnet-4  ✓
  //   claude-sonnet-3-5         → claude-sonnet-3-5 ✓ (unchanged)
  //   claude-haiku-3-5          → claude-haiku-3-5  ✓ (unchanged)
  return model.replace(/^(claude-[a-z]+-4)-\d+.*$/, "$1")
}
```

- [ ] **Step 5.4: Run the tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "translateModelName"
```

Expected: All 7 model name tests PASS.

- [ ] **Step 5.5: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts tests/anthropic-request.test.ts
git commit -m "feat: generalize translateModelName to handle all claude-4+ variants including haiku-4-5"
```

---

### Task 6: Update `mapContent` — add document, server_tool_use cases; update signature

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts`

- [ ] **Step 6.1: Write failing tests for document and server_tool_use in mapContent**

Add to `tests/anthropic-request.test.ts`:

```typescript
test("document block in user message produces placeholder text", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize this PDF." },
          {
            type: "document",
            title: "My Report",
            source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" },
          },
        ],
      },
    ],
    max_tokens: 100,
  }
  const result = translateToOpenAI(anthropicPayload)
  const userMsg = result.messages.find((m) => m.role === "user")
  expect(typeof userMsg?.content).toBe("string")
  const content = userMsg?.content as string
  expect(content).toContain("Summarize this PDF.")
  expect(content).toContain("[Document: PDF content not displayable]")
})

test("server_tool_use block in assistant message is serialized to text", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [
      { role: "user", content: "Search for something." },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "test" } },
          { type: "text", text: "I searched for you." },
        ],
      },
      { role: "user", content: "Thanks." },
    ],
    max_tokens: 100,
  }
  const result = translateToOpenAI(anthropicPayload)
  const assistantMsg = result.messages.find((m) => m.role === "assistant")
  const content = assistantMsg?.content as string
  expect(content).toContain("[Server tool use:")
  expect(content).toContain("web_search")
  expect(content).toContain("I searched for you.")
})
```

- [ ] **Step 6.2: Run the failing tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "placeholder|server_tool_use"
```

Expected: FAIL — `document` and `server_tool_use` blocks fall through to `// No default`.

- [ ] **Step 6.3: Update `mapContent` in `non-stream-translation.ts`**

Find the `mapContent` function. The signature needs to accept the new union members (which it already does since we're reusing the existing `AnthropicUserContentBlock | AnthropicAssistantContentBlock` union — the new block types are already in those unions from Task 2).

**Update the no-image text path** (the `if (!hasImage)` block) — replace it:

```typescript
if (!hasImage) {
  return content
    .filter(
      (block) =>
        block.type === "text"
        || block.type === "thinking"
        || block.type === "document"          // user messages: PDF → placeholder
        || block.type === "server_tool_use",  // assistant messages: serialise to JSON
    )
    .map((block) => {
      if (block.type === "text") return (block as AnthropicTextBlock).text
      if (block.type === "thinking")
        return (block as AnthropicThinkingBlock).thinking
      if (block.type === "document")
        return "[Document: PDF content not displayable]"
      // server_tool_use
      return `[Server tool use: ${JSON.stringify(block)}]`
    })
    .join("\n\n")
}
```

**Add cases to the image-path switch statement** (after the existing `"image"` case):

```typescript
case "document": {
  contentParts.push({
    type: "text",
    text: "[Document: PDF content not displayable]",
  })
  break
}
case "server_tool_use": {
  contentParts.push({
    type: "text",
    text: `[Server tool use: ${JSON.stringify(block)}]`,
  })
  break
}
// redacted_thinking: silently skip — opaque binary data, no OpenAI equivalent
// Keep the existing: // No default
```

- [ ] **Step 6.4: Run the tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "placeholder|server_tool_use"
```

Expected: Both tests PASS.

- [ ] **Step 6.5: Run full suite**

```bash
bun test
```

Expected: All tests pass.

- [ ] **Step 6.6: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts tests/anthropic-request.test.ts
git commit -m "feat: add document and server_tool_use handling to mapContent"
```

---

### Task 7: Update `handleAssistantMessage` — strip `redacted_thinking`, include `server_tool_use` in Branch 1

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts`
- Test: `tests/anthropic-request.test.ts`

- [ ] **Step 7.1: Write failing tests**

Add to `tests/anthropic-request.test.ts`:

```typescript
test("redacted_thinking block is stripped from assistant message (Branch 2, no tool calls)", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [
      { role: "user", content: "Think hard." },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "EncryptedBinaryData==" },
          { type: "text", text: "My considered answer." },
        ],
      },
      { role: "user", content: "Follow up." },
    ],
    max_tokens: 100,
  }
  const result = translateToOpenAI(anthropicPayload)
  const assistantMsg = result.messages.find((m) => m.role === "assistant")
  // Content must contain the text but NOT the redacted data
  expect(assistantMsg?.content).toContain("My considered answer.")
  expect(assistantMsg?.content).not.toContain("EncryptedBinaryData==")
})

test("server_tool_use block is serialized in assistant message with tool calls (Branch 1)", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [
      { role: "user", content: "Do something." },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "test" } },
          { type: "text", text: "Let me also call a tool." },
          { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
        ],
      },
    ],
    max_tokens: 100,
  }
  const result = translateToOpenAI(anthropicPayload)
  const assistantMsg = result.messages.find((m) => m.role === "assistant")
  // Branch 1: has tool_use, so content is the text + server_tool_use serialized
  expect(assistantMsg?.content).toContain("Let me also call a tool.")
  expect(assistantMsg?.content).toContain("[Server tool use:")
  expect(assistantMsg?.tool_calls).toHaveLength(1)
  expect(assistantMsg?.tool_calls?.[0].function.name).toBe("Bash")
})
```

- [ ] **Step 7.2: Run the failing tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "redacted_thinking|Branch 1"
```

Expected: FAIL.

- [ ] **Step 7.3: Update `handleAssistantMessage` in `non-stream-translation.ts`**

> **Prerequisite:** Tasks 1 and 2 (Chunk 1) must be committed. Task 2 adds `AnthropicRedactedThinkingBlock` to `AnthropicAssistantContentBlock` — without that, the `.filter((b) => b.type !== "redacted_thinking")` call is a TypeScript error (the discriminant isn't in the union yet). Task 2 also adds `AnthropicServerToolUseBlock` to `AnthropicAssistantContentBlock`, which is needed for Branch 1's `serverToolUseBlocks` filter.

Find the `handleAssistantMessage` function. It has two branches based on `toolUseBlocks.length > 0`.

**Update Branch 1** (the `toolUseBlocks.length > 0` branch) — add `serverToolUseBlocks` and update `allTextContent`:

```typescript
const serverToolUseBlocks = message.content.filter(
  (block): block is AnthropicServerToolUseBlock => block.type === "server_tool_use",
)

const allTextContent = [
  ...textBlocks.map((b) => b.text),
  ...thinkingBlocks.map((b) => b.thinking),
  ...serverToolUseBlocks.map((b) => `[Server tool use: ${JSON.stringify(b)}]`),
]
  .filter(Boolean)  // strip empty strings from text/thinking .map() to avoid spurious \n\n
  .join("\n\n")

return [
  {
    role: "assistant",
    content: allTextContent || null,  // null not "" when all content is empty (tool-only response)
    tool_calls: toolUseBlocks.map((toolUse) => ({
      id: toolUse.id,
      type: "function",
      function: {
        name: toolUse.name,
        arguments: JSON.stringify(toolUse.input),
      },
    })),
  },
]
```

**Update Branch 2** (the ternary else — content IS an array but has no `tool_use` blocks, currently lines 171–176 in the source) — filter `redacted_thinking` before calling `mapContent`. At this point in `handleAssistantMessage`, the content is always an array (the early return at lines 129–136 handles the non-array case). Remove the `Array.isArray` guard:

```typescript
// Branch 2 — no custom tool_use blocks
// filter out redacted_thinking (opaque binary, no OpenAI equivalent)
// server_tool_use and document are handled by mapContent's updated switch/filter
const visibleContent = (message.content as Array<AnthropicAssistantContentBlock>).filter(
  (b) => b.type !== "redacted_thinking",
)

return [
  {
    role: "assistant",
    content: mapContent(visibleContent),
  },
]
```

- [ ] **Step 7.4: Run the tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "redacted_thinking|Branch 1"
```

Expected: Both PASS.

- [ ] **Step 7.5: Run the full suite**

```bash
bun test
```

Expected: All tests pass.

- [ ] **Step 7.6: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts tests/anthropic-request.test.ts
git commit -m "feat: strip redacted_thinking and serialize server_tool_use in handleAssistantMessage"
```

---

### Task 8: Update `handleUserMessage` — array `tool_result` content + `web_search_tool_result` blocks

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts`
- Test: `tests/anthropic-request.test.ts`

- [ ] **Step 8.1: Write failing tests**

> **Prerequisite:** Task 2 (Chunk 1) must be committed. `AnthropicWebSearchToolResultBlock` (added in Task 2, Step 2.3b) has `content: unknown`, so the test literal's `content` array shape is valid without any cast.

Add to `tests/anthropic-request.test.ts`:

```typescript
test("tool_result with array content containing image is translated to vision ContentPart", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [
      { role: "user", content: "Take a screenshot." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_sc", name: "computer", input: { action: "screenshot" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_sc",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgo=",
                },
              },
            ],
          },
        ],
      },
    ],
    max_tokens: 100,
  }
  const result = translateToOpenAI(anthropicPayload)
  const toolMsg = result.messages.find((m) => m.role === "tool")
  // Should be an array with an image_url part
  expect(Array.isArray(toolMsg?.content)).toBe(true)
  const parts = toolMsg?.content as Array<{ type: string }>
  expect(parts[0].type).toBe("image_url")
})

test("tool_result with array content containing text is translated to string", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [
      { role: "user", content: "Run a command." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_b", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_b",
            content: [
              { type: "text", text: "file1.txt\nfile2.txt" },
            ],
          },
        ],
      },
    ],
    max_tokens: 100,
  }
  const result = translateToOpenAI(anthropicPayload)
  const toolMsg = result.messages.find((m) => m.role === "tool")
  expect(typeof toolMsg?.content).toBe("string")
  expect(toolMsg?.content).toContain("file1.txt")
})

test("web_search_tool_result block is serialized as user message", () => {
  const anthropicPayload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    messages: [
      { role: "user", content: "Search the web." },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srv_ws_1",
            content: [{ type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "abc" }],
          },
        ],
      },
    ],
    max_tokens: 100,
  }
  const result = translateToOpenAI(anthropicPayload)
  const webResultMsg = result.messages.find(
    (m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("[Web search result:")
  )
  expect(webResultMsg).toBeDefined()
})
```

- [ ] **Step 8.2: Run the failing tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "tool_result with array|web_search_tool_result"
```

Expected: FAIL.

- [ ] **Step 8.3: Add `mapToolResultContent` function to `non-stream-translation.ts`**

After the `mapContent` function, add:

```typescript
// Handles tool_result content which may be a string or array of content blocks
function mapToolResultContent(
  content: AnthropicToolResultBlock["content"],
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  // content is an array of text/image/document blocks — reuse mapContent logic
  return mapContent(content)
}
```

- [ ] **Step 8.4: Update `handleUserMessage` in `non-stream-translation.ts`**

Replace the entire `handleUserMessage` function with:

```typescript
function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
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
        block.type !== "web_search_tool_result",
      // document blocks remain here intentionally — mapContent handles them
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapToolResultContent(block.content),
      })
    }

    // Web search result blocks → serialize as user message
    if (webSearchResultBlocks.length > 0) {
      const text = webSearchResultBlocks
        .map((b) => `[Web search result: ${JSON.stringify(b.content)}]`)
        .join("\n\n")
      newMessages.push({ role: "user", content: text })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}
```

- [ ] **Step 8.5: Run the tests**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "tool_result with array|web_search_tool_result"
```

Expected: All 3 PASS.

- [ ] **Step 8.6: Run full suite**

```bash
bun test
```

Expected: All tests pass.

- [ ] **Step 8.7: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts tests/anthropic-request.test.ts
git commit -m "feat: handle array tool_result content and web_search_tool_result blocks in handleUserMessage"
```

---

## Chunk 4: Token Counting (`count-tokens-handler.ts`)

### Task 9: Fix token overhead for Anthropic-typed tools

**Files:**
- Modify: `src/routes/messages/count-tokens-handler.ts`
- Test: `tests/anthropic-request.test.ts` *(token counting uses a different handler — add a focused unit test)*

- [ ] **Step 9.1: Verify `isTypedTool` discriminator (sanity check from Task 1)**

Add to `tests/anthropic-request.test.ts` *(or confirm they already pass if you added them during Task 1)*:

```typescript
// Import the token-counting logic for direct testing
import { isTypedTool } from "../src/routes/messages/anthropic-types"

describe("isTypedTool discriminator", () => {
  test("returns true for a typed tool (no input_schema)", () => {
    const typedTool = { type: "bash_20250124", name: "bash" }
    expect(isTypedTool(typedTool)).toBe(true)
  })

  test("returns false for a custom tool (has input_schema)", () => {
    const customTool = { name: "Bash", description: "Run shell commands", input_schema: {} }
    expect(isTypedTool(customTool)).toBe(false)
  })

  test("returns false for custom tool even if it has extra fields", () => {
    const customTool = { name: "Bash", input_schema: {}, strict: true, cache_control: { type: "ephemeral" } }
    expect(isTypedTool(customTool)).toBe(false)
  })
})
```

- [ ] **Step 9.2: Confirm discriminator tests pass**

```bash
bun test tests/anthropic-request.test.ts --test-name-pattern "isTypedTool"
```

Expected: All 3 PASS (the function was added in Task 1 — these confirm it's correctly exported and behaves as expected). This is a sanity check, not a red-first TDD step.

- [ ] **Step 9.3: Update `count-tokens-handler.ts`**

Open `src/routes/messages/count-tokens-handler.ts`.

**Add import** at the top (after existing imports):

```typescript
import { isTypedTool } from "./anthropic-types"
```

**Add the overhead table** before the `handleCountTokens` function:

```typescript
// Token overhead for Anthropic-typed tools (per Anthropic pricing docs).
// Custom tools use the existing flat +346 for the entire tools array.
// Typed tools add per-tool overhead on top.
const ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD: Record<string, number> = {
  "text_editor_20250728": 700,
  "text_editor_20250429": 700,
  "text_editor_20250124": 700,
  "text_editor_20241022": 700,
  "bash_20250124": 700,
  "bash_20241022": 700,
  // computer_use and web_search: overhead included in beta pricing, not additive
}
```

**Replace the existing tools block** inside `handleCountTokens` (the `if (anthropicPayload.tools && ...)` section):

```typescript
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

      // Preserve existing flat +346 for the custom tools array (unchanged behavior)
      if (hasCustomTools) {
        tokenCount.input = tokenCount.input + 346
      }
      // Add per-typed-tool overhead for Anthropic-typed tools (new)
      for (const tool of typedTools) {
        tokenCount.input =
          tokenCount.input + (ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD[tool.type] ?? 0)
      }
    } else if (anthropicPayload.model.startsWith("grok")) {
      tokenCount.input = tokenCount.input + 480
    }
  }
}
```

- [ ] **Step 9.4: Run typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 9.5: Run full test suite**

```bash
bun test
```

Expected: All tests pass.

- [ ] **Step 9.6: Commit**

```bash
git add src/routes/messages/count-tokens-handler.ts tests/anthropic-request.test.ts
git commit -m "feat: fix token overhead calculation to distinguish typed vs custom tools"
```

---

## Chunk 5: Final Verification

### Task 10: Typecheck, lint, and full regression pass

- [ ] **Step 10.1: Run typecheck — must be clean**

```bash
bun run typecheck
```

Expected output: no errors. If any exist, fix them before proceeding.

- [ ] **Step 10.2: Run lint — must be clean**

```bash
bun run lint:all
```

Expected: no errors (auto-fixable issues are fixed; no unfixable warnings).

- [ ] **Step 10.3: Run the full test suite**

```bash
bun test
```

Expected: All tests PASS. Verify the new tests cover all 11 gaps:

| Gap | Test |
|-----|------|
| Typed tool filtering | "should filter out Anthropic-typed tools" |
| tool_result array (image) | "tool_result with array content containing image" |
| tool_result array (text) | "tool_result with array content containing text" |
| strict forwarded | "should forward strict:true", "should not add strict field" |
| disable_parallel_tool_use | Parsed by type system — covered by TypeScript compile |
| server_tool_use block | "server_tool_use block in assistant message is serialized" |
| document block | "document block in user message produces placeholder text" |
| redacted_thinking block | "redacted_thinking block is stripped", "redacted_thinking in handleAssistantMessage" |
| token overhead | "isTypedTool discriminator" (typed tool filtering is the mechanism) |
| cache_control/defer_loading stripped | Covered by typed tool / custom tool separation tests |
| model name normalization | All 7 "translateModelName normalization" tests |

- [ ] **Step 10.4: Build — make sure the project compiles**

```bash
bun run build
```

Expected: Build succeeds with output in `dist/`.

- [ ] **Step 10.5: Final commit (if any unstaged changes remain)**

```bash
git status
# If there are unstaged changes (should be none if each task was committed properly):
git add src/routes/messages/anthropic-types.ts src/routes/messages/non-stream-translation.ts src/routes/messages/count-tokens-handler.ts src/services/copilot/create-chat-completions.ts tests/anthropic-request.test.ts
git commit -m "chore: verify tool parity — all 11 gaps fixed, typecheck and build clean"
```

---

### Task 11: Summary commit with changelog note

- [ ] **Step 11.1: Verify git log shows all work**

```bash
git log --oneline -10
```

Expected: See all the commits from Tasks 1–10 cleanly stacked.

- [ ] **Step 11.2: Done — no PR needed unless upstream integration is required**

All 11 gaps are fixed across 4 files with full test coverage. The proxy now handles:
- **Claude Code v2.1.76** — all 24+ tools pass through correctly; extra fields (`cache_control`, `defer_loading`, `strict`, etc.) handled
- **Computer use workflows** — screenshot `tool_result` images translate to `image_url`
- **Multi-turn histories** — `server_tool_use`, `web_search_tool_result`, `redacted_thinking` no longer crash
- **Other Anthropic clients** — `bash_20250124`, `text_editor_*`, `computer_*` typed tools silently filtered
- **Model normalization** — all current and future `claude-4+` variants normalize correctly

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `bun test` | Run all tests |
| `bun test tests/anthropic-request.test.ts` | Run request-translation tests only |
| `bun run typecheck` | TypeScript type check (no emit) |
| `bun run lint:all` | ESLint entire project |
| `bun run build` | Compile to `dist/` via tsdown |
| `bun run dev` | Start in watch mode |
