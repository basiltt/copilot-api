import { describe, test, expect } from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { resolveModelId } from "~/lib/model-resolver"

function makeModels(ids: Array<string>): ModelsResponse {
  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      name: id,
      object: "model",
      vendor: "copilot",
      version: "1",
      model_picker_enabled: true,
      preview: false,
      capabilities: {
        family: "gpt",
        tokenizer: "o200k_base",
        type: "chat",
        object: "model_capabilities",
        supports: {},
        limits: {
          max_context_window_tokens: 128000,
          max_prompt_tokens: 128000,
          max_output_tokens: 4096,
        },
      },
    })),
  }
}

const COPILOT_MODELS = makeModels([
  "claude-opus-4.6",
  "claude-opus-4.7",
  "claude-opus-4.8",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-opus-4.5",
  "claude-haiku-4.5",
  "gemini-3.1-pro-preview",
  "gemini-2.5-pro",
  "gpt-5.4",
  "gpt-4.1",
  "gpt-4.1-2025-04-14",
  "gpt-4-0125-preview",
  "gpt-4o-2024-11-20",
  "gpt-4",
])

describe("resolveModelId — exact match", () => {
  test("returns the same id when it exactly matches an available model", () => {
    expect(resolveModelId("claude-opus-4.8", COPILOT_MODELS)).toBe(
      "claude-opus-4.8",
    )
  })

  test("prefers an exact (hyphenated) match over canonical rewriting", () => {
    // gpt-4-0125-preview legitimately uses hyphens — must not be altered
    expect(resolveModelId("gpt-4-0125-preview", COPILOT_MODELS)).toBe(
      "gpt-4-0125-preview",
    )
  })
})

describe("resolveModelId — hyphen/dot normalization", () => {
  test("resolves claude-opus-4-8 to claude-opus-4.8", () => {
    expect(resolveModelId("claude-opus-4-8", COPILOT_MODELS)).toBe(
      "claude-opus-4.8",
    )
  })

  test("resolves claude-sonnet-4-6 to claude-sonnet-4.6", () => {
    expect(resolveModelId("claude-sonnet-4-6", COPILOT_MODELS)).toBe(
      "claude-sonnet-4.6",
    )
  })

  test("resolves gpt-5-4 to gpt-5.4", () => {
    expect(resolveModelId("gpt-5-4", COPILOT_MODELS)).toBe("gpt-5.4")
  })

  test("resolves gemini-3-1-pro-preview to gemini-3.1-pro-preview", () => {
    expect(resolveModelId("gemini-3-1-pro-preview", COPILOT_MODELS)).toBe(
      "gemini-3.1-pro-preview",
    )
  })

  test("resolves gpt-4-1 to gpt-4.1 (without colliding with gpt-4.1-2025-04-14)", () => {
    expect(resolveModelId("gpt-4-1", COPILOT_MODELS)).toBe("gpt-4.1")
  })

  test("is case-insensitive when matching", () => {
    expect(resolveModelId("Claude-Opus-4-8", COPILOT_MODELS)).toBe(
      "claude-opus-4.8",
    )
  })
})

describe("resolveModelId Fable zero-minor aliases", () => {
  test.each([
    "claude-fable-5.0",
    "claude-fable-5-0",
    "Claude-Fable-5.0",
    "claude-fable-5.0[1m]",
    "claude-fable-5-0-20260901",
  ])("resolves %s only against an available matching model", (alias) => {
    expect(resolveModelId(alias, makeModels(["claude-fable-5"]))).toBe(
      "claude-fable-5",
    )
  })

  test("an exact zero-minor catalog entry still wins", () => {
    const models = makeModels(["claude-fable-5", "claude-fable-5.0"])
    expect(resolveModelId("claude-fable-5.0", models)).toBe("claude-fable-5.0")
    expect(resolveModelId("claude-fable-5", models)).toBe("claude-fable-5")
  })

  test.each([
    "claude-fable-5.2",
    "claude-fable-50",
    "claude-fable-5.0-preview",
  ])("does not guess a model for %s", (id) => {
    expect(resolveModelId(id, makeModels(["claude-fable-5"]))).toBe(id)
  })
})

describe("resolveModelId — Anthropic date-stamp stripping", () => {
  test("resolves claude-haiku-4-5-20251001 to claude-haiku-4.5", () => {
    expect(resolveModelId("claude-haiku-4-5-20251001", COPILOT_MODELS)).toBe(
      "claude-haiku-4.5",
    )
  })

  test("resolves claude-sonnet-4-5-20250929 to claude-sonnet-4.5", () => {
    expect(resolveModelId("claude-sonnet-4-5-20250929", COPILOT_MODELS)).toBe(
      "claude-sonnet-4.5",
    )
  })

  test("resolves a dotted+dated id (claude-haiku-4.5-20251001)", () => {
    expect(resolveModelId("claude-haiku-4.5-20251001", COPILOT_MODELS)).toBe(
      "claude-haiku-4.5",
    )
  })

  test("is case-insensitive with a date stamp", () => {
    expect(resolveModelId("Claude-Haiku-4-5-20251001", COPILOT_MODELS)).toBe(
      "claude-haiku-4.5",
    )
  })

  test("does not strip Copilot's own hyphen-dated ids (gpt-4.1-2025-04-14)", () => {
    // Ends in two digits, not eight — exact match must win, untouched.
    expect(resolveModelId("gpt-4.1-2025-04-14", COPILOT_MODELS)).toBe(
      "gpt-4.1-2025-04-14",
    )
  })

  test("returns original when stripping still finds no match", () => {
    expect(resolveModelId("claude-haiku-9-9-20251001", COPILOT_MODELS)).toBe(
      "claude-haiku-9-9-20251001",
    )
  })
})

describe("resolveModelId — no match", () => {
  test("returns the original id when no model matches", () => {
    expect(resolveModelId("claude-opus-9-9", COPILOT_MODELS)).toBe(
      "claude-opus-9-9",
    )
  })

  test("returns the original id when models is undefined", () => {
    expect(resolveModelId("claude-opus-4-8", undefined)).toBe("claude-opus-4-8")
  })

  test("returns the original id for empty/whitespace input", () => {
    expect(resolveModelId("", COPILOT_MODELS)).toBe("")
  })
})

describe("resolveModelId — [1m] context-window marker", () => {
  // Claude Code / Claude Desktop append `[1m]` when the user picks the
  // 1M-context row.  Copilot has no such catalog entry and returns
  // `400 model_not_supported`, so the marker must be stripped before matching.
  test("strips [1m] and resolves to the base model", () => {
    expect(resolveModelId("claude-sonnet-4.6[1m]", COPILOT_MODELS)).toBe(
      "claude-sonnet-4.6",
    )
  })

  test("strips [1m] combined with hyphenated version form", () => {
    expect(resolveModelId("claude-opus-4-8[1m]", COPILOT_MODELS)).toBe(
      "claude-opus-4.8",
    )
  })

  test("strips [1m] combined with an Anthropic date stamp", () => {
    expect(
      resolveModelId("claude-haiku-4-5-20251001[1m]", COPILOT_MODELS),
    ).toBe("claude-haiku-4.5")
  })

  test("is case-insensitive", () => {
    expect(resolveModelId("claude-sonnet-4.6[1M]", COPILOT_MODELS)).toBe(
      "claude-sonnet-4.6",
    )
  })

  test("strips [1m] even when the catalog is unavailable", () => {
    expect(resolveModelId("claude-sonnet-5[1m]", undefined)).toBe(
      "claude-sonnet-5",
    )
  })

  test("strips [1m] even when the base id is not in the catalog", () => {
    // Better to forward a bare unknown id (which may still be valid upstream)
    // than one carrying a marker guaranteed to 400.
    expect(resolveModelId("claude-future-9[1m]", COPILOT_MODELS)).toBe(
      "claude-future-9",
    )
  })

  test("leaves bracket-free ids untouched", () => {
    expect(resolveModelId("claude-sonnet-4.6", COPILOT_MODELS)).toBe(
      "claude-sonnet-4.6",
    )
  })
})

describe("resolveModelId — Codex internal model aliases", () => {
  // Codex hardcodes these ids for internal turns regardless of the configured
  // model, so they hit a custom gateway verbatim and 400 (openai/codex#24879).
  const WITH_MINI = makeModels([
    "gpt-5.4-mini",
    "gpt-5.6-sol",
    "claude-sonnet-5",
  ])

  test("maps codex-auto-review onto a real catalog model", () => {
    expect(resolveModelId("codex-auto-review", WITH_MINI)).toBe("gpt-5.4-mini")
  })

  test("falls through preference order when the first choice is absent", () => {
    const onlyLegacy = makeModels(["gpt-4o-mini", "gpt-5.6-sol"])
    expect(resolveModelId("codex-auto-review", onlyLegacy)).toBe("gpt-4o-mini")
  })

  test("returns the id unchanged when no fallback exists in the catalog", () => {
    const noMini = makeModels(["gpt-5.6-sol"])
    expect(resolveModelId("codex-auto-review", noMini)).toBe(
      "codex-auto-review",
    )
  })

  test("a real catalog entry of the same name always wins", () => {
    // `trajectory-compaction` is a genuine Copilot model; never override it.
    const withReal = makeModels(["trajectory-compaction", "gpt-5.4-mini"])
    expect(resolveModelId("trajectory-compaction", withReal)).toBe(
      "trajectory-compaction",
    )
  })

  test("does not touch ordinary model ids", () => {
    expect(resolveModelId("gpt-5.6-sol", WITH_MINI)).toBe("gpt-5.6-sol")
  })
})
