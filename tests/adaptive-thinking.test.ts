import { describe, test, expect } from "bun:test"

import { isThinkingRequested } from "~/routes/messages/anthropic-types"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

/**
 * Per the gateway protocol reference, Claude Code and Claude Desktop send
 * `thinking: {"type": "adaptive"}` for Claude 4.6 and later — and treat model
 * names they don't recognize, such as gateway aliases, as current models that
 * receive the field. Behind this proxy every Claude model is effectively an
 * alias, so `adaptive` arrives on the majority of real desktop traffic.
 *
 * Matching only `"enabled"` therefore read as "thinking off" in production:
 * upstream reasoning was never requested, and reasoning the model produced
 * anyway was rendered as ordinary assistant text — the model's private
 * chain-of-thought shown to the user as its answer.
 *
 * @see https://code.claude.com/docs/en/llm-gateway-protocol
 */
describe("isThinkingRequested", () => {
  test("treats adaptive as thinking requested", () => {
    expect(isThinkingRequested({ type: "adaptive" })).toBe(true)
  })

  test("treats enabled as thinking requested", () => {
    expect(isThinkingRequested({ type: "enabled" })).toBe(true)
  })

  test("treats disabled as thinking not requested", () => {
    expect(isThinkingRequested({ type: "disabled" })).toBe(false)
  })

  test("treats an absent thinking field as not requested", () => {
    expect(isThinkingRequested(undefined)).toBe(false)
  })
})

describe("adaptive thinking → upstream reasoning control", () => {
  test("requests reasoning from upstream for adaptive", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "What is 17*23?" }],
      max_tokens: 512,
      thinking: { type: "adaptive" },
    })

    // `summary: "auto"` is what makes Copilot stream reasoning deltas in real
    // time; without it the reasoning surfaces as plain text at end of turn.
    expect(result.reasoning).toEqual({ effort: "medium", summary: "auto" })
  })

  test("requests reasoning from upstream for enabled", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "What is 17*23?" }],
      max_tokens: 512,
      thinking: { type: "enabled", budget_tokens: 1024 },
    })

    expect(result.reasoning).toEqual({ effort: "low", summary: "auto" })
  })

  test("omits the reasoning control when thinking is disabled", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 512,
      thinking: { type: "disabled" },
    })

    expect(result.reasoning).toBeUndefined()
  })

  test("omits the reasoning control when thinking is absent", () => {
    const result = translateToOpenAI({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 512,
    })

    expect(result.reasoning).toBeUndefined()
  })

  test("maps budget_tokens to effort on the adaptive path too", () => {
    const high = translateToOpenAI({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 512,
      thinking: { type: "adaptive", budget_tokens: 32_000 },
    })

    expect(high.reasoning?.effort).toBe("high")
  })

  test("output_config.effort controls adaptive thinking depth (takes precedence)", () => {
    const low = translateToOpenAI({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 512,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    })
    expect(low.reasoning?.effort).toBe("low")

    // Newer xhigh/max depths clamp to Copilot's max supported effort ("high").
    const max = translateToOpenAI({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 512,
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    })
    expect(max.reasoning?.effort).toBe("high")

    // Explicit effort wins over the budget_tokens-derived level.
    const explicit = translateToOpenAI({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 512,
      thinking: { type: "adaptive", budget_tokens: 1024 },
      output_config: { effort: "high" },
    })
    expect(explicit.reasoning?.effort).toBe("high")
  })
})
