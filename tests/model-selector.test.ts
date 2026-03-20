import { describe, test, expect } from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { selectModelForTokenCount } from "~/lib/model-selector"

function makeModels(
  list: Array<{
    id: string
    max_context_window_tokens?: number
    max_prompt_tokens?: number
  }>,
): ModelsResponse {
  return {
    object: "list",
    data: list.map((m) => ({
      id: m.id,
      name: m.id,
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
          max_context_window_tokens: m.max_context_window_tokens,
          max_prompt_tokens: m.max_prompt_tokens,
          max_output_tokens: 4096,
        },
      },
    })),
  }
}

describe("selectModelForTokenCount — no overflow", () => {
  test("returns switched: false when tokens within limit", () => {
    const models = makeModels([
      { id: "gpt-4o", max_context_window_tokens: 128000 },
    ])
    const result = selectModelForTokenCount("gpt-4o", models, 1000)
    expect(result.switched).toBe(false)
    expect(result.model).toBe("gpt-4o")
  })

  test("returns switched: false when tokens exactly equal limit", () => {
    const models = makeModels([
      { id: "gpt-4o", max_context_window_tokens: 128000 },
    ])
    const result = selectModelForTokenCount("gpt-4o", models, 128000)
    expect(result.switched).toBe(false)
  })
})

describe("selectModelForTokenCount — overflow detected", () => {
  test("switches to largest context model when overflow", () => {
    const models = makeModels([
      { id: "small-model", max_context_window_tokens: 12288 },
      { id: "large-model", max_context_window_tokens: 128000 },
    ])
    const result = selectModelForTokenCount("small-model", models, 55000)
    expect(result.switched).toBe(true)
    expect(result.model).toBe("large-model")
  })

  test("reason string contains prompt size, requested model, new model", () => {
    const models = makeModels([
      { id: "small-model", max_context_window_tokens: 12288 },
      { id: "large-model", max_context_window_tokens: 128000 },
    ])
    const result = selectModelForTokenCount("small-model", models, 55000)
    expect(result.reason).toContain("55000")
    expect(result.reason).toContain("small-model")
    expect(result.reason).toContain("large-model")
  })

  test("returns switched: false when already on largest context model", () => {
    const models = makeModels([
      { id: "small-model", max_context_window_tokens: 12288 },
      { id: "large-model", max_context_window_tokens: 128000 },
    ])
    const result = selectModelForTokenCount("large-model", models, 130000)
    expect(result.switched).toBe(false)
    expect(result.model).toBe("large-model")
    expect(result.reason).toBeUndefined()
  })
})

describe("selectModelForTokenCount — missing data", () => {
  test("returns switched: false when requested model not in list", () => {
    const models = makeModels([
      { id: "other-model", max_context_window_tokens: 128000 },
    ])
    const result = selectModelForTokenCount("unknown-model", models, 999999)
    expect(result.switched).toBe(false)
    expect(result.model).toBe("unknown-model")
  })

  test("returns switched: false when model has no context window data", () => {
    const models = makeModels([{ id: "mystery-model" }])
    const result = selectModelForTokenCount("mystery-model", models, 999999)
    expect(result.switched).toBe(false)
  })

  test("falls back to max_prompt_tokens when max_context_window_tokens absent", () => {
    const models = makeModels([
      { id: "small-model", max_prompt_tokens: 4096 },
      { id: "large-model", max_context_window_tokens: 128000 },
    ])
    const result = selectModelForTokenCount("small-model", models, 10000)
    expect(result.switched).toBe(true)
    expect(result.model).toBe("large-model")
  })
})
