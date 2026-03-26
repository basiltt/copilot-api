import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import {
  fetchWithImageStripping,
  type ImageStrippingResult,
} from "~/routes/messages/image-stripping"

const originalEnabled = process.env.IMAGE_CONTEXT_TRIMMING_ENABLED
const originalThreshold = process.env.IMAGE_CONTEXT_TRIMMING_BEFORE_MESSAGES

beforeEach(() => {
  delete process.env.IMAGE_CONTEXT_TRIMMING_ENABLED
  delete process.env.IMAGE_CONTEXT_TRIMMING_BEFORE_MESSAGES
})

afterEach(() => {
  if (originalEnabled === undefined) {
    delete process.env.IMAGE_CONTEXT_TRIMMING_ENABLED
  } else {
    process.env.IMAGE_CONTEXT_TRIMMING_ENABLED = originalEnabled
  }

  if (originalThreshold === undefined) {
    delete process.env.IMAGE_CONTEXT_TRIMMING_BEFORE_MESSAGES
  } else {
    process.env.IMAGE_CONTEXT_TRIMMING_BEFORE_MESSAGES = originalThreshold
  }
})

async function capturePayload(
  payload: AnthropicMessagesPayload,
): Promise<ImageStrippingResult<AnthropicMessagesPayload>> {
  return fetchWithImageStripping(
    (receivedPayload) => Promise.resolve(receivedPayload),
    payload,
  )
}

function buildImage(data = "A".repeat(4_000)) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/png" as const,
      data,
    },
  }
}

describe("processed image trimming", () => {
  test("does not trim anything when feature is disabled", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "look" }, buildImage()],
        },
        { role: "assistant", content: "I inspected it." },
        { role: "user", content: "continue" },
      ],
    }

    const result = await capturePayload(payload)
    expect(result.response).toEqual(payload)
  })

  test("trims processed images once they are older than the configured message threshold", async () => {
    process.env.IMAGE_CONTEXT_TRIMMING_ENABLED = "true"
    process.env.IMAGE_CONTEXT_TRIMMING_BEFORE_MESSAGES = "2"

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "look" }, buildImage()],
        },
        { role: "assistant", content: "I inspected the screenshot." },
        { role: "user", content: "make a change" },
        { role: "assistant", content: "Done." },
      ],
    }

    const result = await capturePayload(payload)
    const firstMessage = result.response.messages[0]
    expect(firstMessage.role).toBe("user")
    if (typeof firstMessage.content === "string") {
      throw new TypeError("Expected block content")
    }
    expect(firstMessage.content[1]).toEqual({
      type: "text",
      text: "[Processed image trimmed to reduce request size]",
    })
  })

  test("keeps back-to-back screenshots when the assistant has not processed them yet", async () => {
    process.env.IMAGE_CONTEXT_TRIMMING_ENABLED = "true"
    process.env.IMAGE_CONTEXT_TRIMMING_BEFORE_MESSAGES = "0"

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [buildImage("A".repeat(5_000))],
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [buildImage("B".repeat(5_000))],
            },
          ],
        },
      ],
    }

    const result = await capturePayload(payload)
    expect(result.response).toEqual(payload)
  })

  test("trims nested tool_result images after a later assistant explanation", async () => {
    process.env.IMAGE_CONTEXT_TRIMMING_ENABLED = "true"
    process.env.IMAGE_CONTEXT_TRIMMING_BEFORE_MESSAGES = "1"

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [buildImage("A".repeat(5_000))],
            },
          ],
        },
        {
          role: "assistant",
          content: "I compared both screenshots and found the layout issue.",
        },
        { role: "user", content: "continue" },
      ],
    }

    const result = await capturePayload(payload)
    const firstMessage = result.response.messages[0]
    if (typeof firstMessage.content === "string") {
      throw new TypeError("Expected block content")
    }
    const toolResult = firstMessage.content[0]
    if (
      toolResult.type !== "tool_result"
      || typeof toolResult.content === "string"
    ) {
      throw new TypeError("Expected nested tool result content")
    }
    expect(toolResult.content[0]).toEqual({
      type: "text",
      text: "[Processed image trimmed to reduce request size]",
    })
  })
})
