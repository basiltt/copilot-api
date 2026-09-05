import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { normalizeReasoningEffort } from "~/lib/reasoning-effort"

import {
  makeReasoningModel,
  reasoningCatalog,
} from "./fixtures/reasoning-models"

describe("Ultra reasoning effort policy", () => {
  test.each([
    ["gpt-6-astra", "max"],
    ["gpt-5.6-sol", "max"],
    ["gpt-5.6-terra", "max"],
    ["gpt-5.6-luna", "max"],
    ["gpt-5.5", "xhigh"],
    ["gpt-5.4", "xhigh"],
    ["gpt-5.4-2026-03-05", "xhigh"],
    ["gpt-5.4-mini", "xhigh"],
    ["gpt-5.3-codex", "xhigh"],
    ["gpt-5-mini", "high"],
    ["gpt-5-mini-2025-08-07", "high"],
  ])("uses the verified %s maximum %s without a catalog", (model, maximum) => {
    expect(
      normalizeReasoningEffort("ultra", model, { param: "reasoning.effort" }),
    ).toBe(maximum)
  })

  test.each(["ultra", "Ultra", "ULTRA", "uLtRa"])(
    "recognizes %s case-insensitively",
    (effort) => {
      expect(
        normalizeReasoningEffort(effort, "gpt-6-astra", {
          param: "reasoning_effort",
        }),
      ).toBe("max")
    },
  )

  test.each([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "High",
    "MAX",
    "unknown",
    " ultra ",
    "",
    undefined,
    null,
    42,
    {},
  ])(
    "leaves non-Ultra value %p unchanged without capability lookup",
    (effort) => {
      expect(
        normalizeReasoningEffort(effort, "unknown-model", {
          param: "reasoning.effort",
        }),
      ).toBe(effort)
    },
  )

  test.each([
    { efforts: ["high", "max", "low", "xhigh"], maximum: "max" },
    { efforts: ["xhigh", "low", "high", "none"], maximum: "xhigh" },
    { efforts: ["high", "medium", "low"], maximum: "high" },
    { efforts: ["none", "medium", "low"], maximum: "medium" },
    { efforts: ["low", "none"], maximum: "low" },
    { efforts: ["none", "minimal"], maximum: "minimal" },
  ])(
    "ranks explicit metadata independently of list order: %p",
    ({ efforts, maximum }) => {
      const model = makeReasoningModel(
        "future-reasoner",
        ["/responses"],
        efforts,
      )
      const before = structuredClone(model)
      expect(
        normalizeReasoningEffort("Ultra", model.id, {
          models: reasoningCatalog(model),
          param: "reasoning.effort",
        }),
      ).toBe(maximum)
      expect(model).toEqual(before)
    },
  )

  test.each([
    { id: "gpt-6-astra", efforts: ["low", "high"], maximum: "high" },
    { id: "gpt-5-mini", efforts: ["max", "low"], maximum: "max" },
  ])(
    "explicit metadata overrides the verified default: %p",
    ({ id, efforts, maximum }) => {
      const model = makeReasoningModel(id, ["/responses"], efforts)
      expect(
        normalizeReasoningEffort("ultra", id, {
          models: reasoningCatalog(model),
          param: "reasoning_effort",
        }),
      ).toBe(maximum)
    },
  )

  test.each([
    { efforts: [] },
    { efforts: ["none"] },
    { efforts: ["high", "future-effort"] },
    { efforts: ["ultra"] },
    { efforts: ["MAX"] },
    { efforts: [1, "max"] },
    { efforts: null },
    { efforts: false },
    { efforts: "max" },
  ])(
    "rejects unusable explicit metadata %p instead of using a default",
    ({ efforts }) => {
      const model = makeReasoningModel("gpt-6-astra")
      Object.assign(model.capabilities.supports, { reasoning_effort: efforts })
      expect(() =>
        normalizeReasoningEffort("ultra", model.id, {
          models: reasoningCatalog(model),
          param: "reasoning.effort",
        }),
      ).toThrow(HTTPError)
    },
  )

  test("explicit non-chat capability takes precedence over an effort list", () => {
    const model = makeReasoningModel("gpt-6-astra", ["/responses"], ["max"])
    model.capabilities.type = "embeddings"
    expect(() =>
      normalizeReasoningEffort("ultra", model.id, {
        models: reasoningCatalog(model),
        param: "reasoning.effort",
      }),
    ).toThrow("the catalog does not identify a chat model")
  })

  test.each([
    "gpt-6-next",
    "gpt-5.6-next",
    "gpt-4o",
    "claude-opus-5",
    "constructor",
    "",
  ])("does not infer a maximum for %s", (id) => {
    const model = makeReasoningModel(id)
    model.capabilities.family = "gpt-6-astra"
    expect(() =>
      normalizeReasoningEffort("ultra", id, {
        models: reasoningCatalog(model),
        param: "reasoning.effort",
      }),
    ).toThrow("no supported reasoning efforts or verified maximum")
  })

  test("handles missing runtime capabilities using only an exact verified default", () => {
    const model = makeReasoningModel("gpt-6-astra")
    Reflect.deleteProperty(model, "capabilities")
    expect(
      normalizeReasoningEffort("ultra", model.id, {
        models: reasoningCatalog(model),
        param: "reasoning.effort",
      }),
    ).toBe("max")

    model.id = "unknown-model"
    expect(() =>
      normalizeReasoningEffort("ultra", model.id, {
        models: reasoningCatalog(model),
        param: "reasoning.effort",
      }),
    ).toThrow(HTTPError)
  })

  test("handles missing runtime supports without inventing an effort", () => {
    const model = makeReasoningModel("gpt-5-mini")
    Reflect.deleteProperty(model.capabilities, "supports")
    expect(
      normalizeReasoningEffort("ultra", model.id, {
        models: reasoningCatalog(model),
        param: "reasoning_effort",
      }),
    ).toBe("high")
  })

  test.each([undefined, null, "low", "max"])(
    "does not apply capability rejection to ordinary effort %p",
    (effort) => {
      const model = makeReasoningModel("gpt-6-astra", ["/responses"], [])
      model.capabilities.type = "embeddings"
      expect(
        normalizeReasoningEffort(effort, model.id, {
          models: reasoningCatalog(model),
          param: "reasoning.effort",
        }),
      ).toBe(effort)
    },
  )
})
