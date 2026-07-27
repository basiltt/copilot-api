import { describe, test, expect } from "bun:test"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { requiresChatCompletionsApi } from "~/services/copilot/responses-translation"

function makeModel(id: string, supportedEndpoints?: Array<string>): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    preview: false,
    capabilities: {
      family: "test",
      tokenizer: "o200k_base",
      type: "chat",
      object: "model_capabilities",
      supports: {},
      limits: {
        max_context_window_tokens: 128_000,
        max_prompt_tokens: 128_000,
        max_output_tokens: 4096,
      },
    },
    ...(supportedEndpoints ? { supported_endpoints: supportedEndpoints } : {}),
  }
}

const CATALOG: ModelsResponse = {
  object: "list",
  data: [
    makeModel("future-model-9", ["/responses"]),
    makeModel("gpt-5.9-weird", ["/chat/completions"]),
    makeModel("claude-sonnet-5", ["/chat/completions"]),
    makeModel("no-endpoints-listed"),
  ],
}

/**
 * Routing decides whether a `/v1/responses` request is passed through natively
 * or translated to Chat Completions.  The translated path is lossy — it drops
 * `reasoning`, `parallel_tool_calls`, and all built-in tools, and emits a
 * reduced SSE event set — so misrouting a natively-capable model silently
 * degrades it.
 */
describe("requiresChatCompletionsApi — catalog capabilities take precedence", () => {
  test("routes natively when the catalog says the model serves /responses", () => {
    // Name matches no known prefix, but the catalog is authoritative.
    expect(requiresChatCompletionsApi("future-model-9", CATALOG)).toBe(false)
  })

  test("translates when the catalog says the model is chat-completions-only", () => {
    // Matches the `gpt-5` prefix, but the catalog overrides the name heuristic.
    expect(requiresChatCompletionsApi("gpt-5.9-weird", CATALOG)).toBe(true)
  })

  test("translates Claude models", () => {
    expect(requiresChatCompletionsApi("claude-sonnet-5", CATALOG)).toBe(true)
  })
})

describe("requiresChatCompletionsApi — name-list fallback", () => {
  test("falls back to the prefix list when the catalog omits endpoints", () => {
    expect(requiresChatCompletionsApi("no-endpoints-listed", CATALOG)).toBe(true)
  })

  test("falls back to the prefix list when no catalog is supplied", () => {
    expect(requiresChatCompletionsApi("gpt-5.6-sol", undefined)).toBe(false)
    expect(requiresChatCompletionsApi("claude-sonnet-5", undefined)).toBe(true)
  })

  test("routes known OpenAI families natively", () => {
    for (const id of [
      "gpt-5.6-sol",
      "gpt-5.3-codex",
      "gpt-4.1",
      "gpt-41-copilot",
      "o3-mini",
    ]) {
      expect(requiresChatCompletionsApi(id, undefined)).toBe(false)
    }
  })

  test("routes a future gpt-6 model natively rather than degrading it", () => {
    expect(requiresChatCompletionsApi("gpt-6-alpha", undefined)).toBe(false)
  })
})
