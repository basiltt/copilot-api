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
