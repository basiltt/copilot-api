import { describe, expect, test } from "bun:test"

import {
  translateFromResponsesPayloadToCC,
  translateToResponsesPayload,
} from "~/services/copilot/responses-translation"

describe("reasoning controls across API translation", () => {
  test.each(["none", "minimal", "low", "medium", "high", "xhigh", "max"])(
    "preserves effective effort %s in both directions",
    (effort) => {
      const reasoning = {
        effort,
        summary: "auto",
        custom_control: { enabled: true },
      }
      const payload = { model: "test-model", input: "hello", reasoning }
      const cc = translateFromResponsesPayloadToCC(payload)
      expect(cc.reasoning_effort).toBe(effort)
      expect(cc.reasoning).toEqual(reasoning)

      const responses = translateToResponsesPayload(cc)
      expect(responses.reasoning).toEqual(reasoning)
      expect(payload.reasoning).toEqual(reasoning)
    },
  )

  test("standard Chat Completions effort overrides the nested extension without losing fields", () => {
    const reasoning = { effort: "low", summary: "detailed", custom_control: 17 }
    const result = translateToResponsesPayload({
      model: "gpt-6-astra",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "max",
      reasoning,
    })
    expect(result.reasoning).toEqual({ ...reasoning, effort: "max" })
    expect(reasoning.effort).toBe("low")
  })

  test("keeps the existing Anthropic/internal reasoning extension unchanged", () => {
    const reasoning = { effort: "high", summary: "auto" }
    const result = translateToResponsesPayload({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      reasoning,
    })
    expect(result.reasoning).toBe(reasoning)
  })

  test.each([undefined, null])(
    "does not add a reasoning effort for %p",
    (effort) => {
      const result = translateToResponsesPayload({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: effort,
      })
      expect(result).not.toHaveProperty("reasoning")
    },
  )

  test("preserves summary-only reasoning without adding an effort", () => {
    const cc = translateFromResponsesPayloadToCC({
      model: "test-model",
      input: "hello",
      reasoning: { summary: "auto" },
    })
    expect(cc.reasoning).toEqual({ summary: "auto" })
    expect(cc).not.toHaveProperty("reasoning_effort")
    expect(translateToResponsesPayload(cc).reasoning).toEqual({
      summary: "auto",
    })
  })

  test("keeps absent reasoning absent in both directions", () => {
    const cc = translateFromResponsesPayloadToCC({
      model: "test-model",
      input: "hello",
    })
    expect(cc).not.toHaveProperty("reasoning")
    expect(cc).not.toHaveProperty("reasoning_effort")
    expect(translateToResponsesPayload(cc)).not.toHaveProperty("reasoning")
  })

  test("preserves null Responses reasoning without adding an effort", () => {
    const cc = translateFromResponsesPayloadToCC({
      model: "test-model",
      input: "hello",
      reasoning: null,
    })
    expect(cc.reasoning).toBeNull()
    expect(cc).not.toHaveProperty("reasoning_effort")
  })
})
