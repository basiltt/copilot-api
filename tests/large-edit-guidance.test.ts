import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { applyLargeEditGuidance } from "~/routes/messages/large-edit-guidance"

function buildPayload(toolNames: Array<string>): ChatCompletionsPayload {
  return {
    model: "claude-opus-4.6",
    max_tokens: 64_000,
    messages: [{ role: "user", content: "Make the requested code change." }],
    tools: toolNames.map((name) => ({
      type: "function",
      function: {
        name,
        description: `${name} tool`,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    })),
  }
}

describe("applyLargeEditGuidance", () => {
  test("injects a system hint for low-output models with file-edit tools", () => {
    const payload = buildPayload(["Read", "Write", "Edit"])

    applyLargeEditGuidance(payload, 32_000)

    expect(payload.messages[0]).toMatchObject({
      role: "system",
    })
    expect(payload.messages[0]?.content).toContain("File-editing budget:")
    expect(payload.messages[0]?.content).toContain("32,000")
  })

  test("upgrades guidance for obviously risky one-shot large rewrite requests", () => {
    const payload = buildPayload(["Write"])
    payload.messages = [
      {
        role: "user",
        content:
          "Write the complete file in exactly one Write call with 9000 lines. Do not split it.",
      },
    ]

    applyLargeEditGuidance(payload, 32_000)

    expect(payload.messages[0]?.content).toContain(
      "High-risk large edit detected:",
    )
    expect(payload.messages[0]?.content).toContain(
      "Do not satisfy this request with one massive Write/Edit/MultiEdit call",
    )
  })

  test("does not inject guidance when no file-edit tools are present", () => {
    const payload = buildPayload(["Read", "Bash"])

    applyLargeEditGuidance(payload, 32_000)

    expect(payload.messages).toHaveLength(1)
    expect(payload.messages[0]?.role).toBe("user")
  })

  test("does not inject guidance for higher-output models", () => {
    const payload = buildPayload(["Write"])

    applyLargeEditGuidance(payload, 64_000)

    expect(payload.messages).toHaveLength(1)
    expect(payload.messages[0]?.role).toBe("user")
  })

  test("does not duplicate guidance when it already exists", () => {
    const payload = buildPayload(["Write"])
    payload.messages.unshift({
      role: "system",
      content:
        "File-editing budget: this model can emit about 32,000 output tokens in one turn.",
    })

    applyLargeEditGuidance(payload, 32_000)

    expect(
      payload.messages.filter(
        (message) =>
          message.role === "system"
          && typeof message.content === "string"
          && message.content.includes("File-editing budget:"),
      ),
    ).toHaveLength(1)
  })
})
