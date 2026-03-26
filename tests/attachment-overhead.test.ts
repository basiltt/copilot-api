import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { estimateAdditionalAttachmentTokens } from "~/routes/messages/attachment-overhead"

describe("estimateAdditionalAttachmentTokens", () => {
  test("adds substantial overhead for direct PDF attachments", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "A".repeat(240_000),
              },
            },
            { type: "text", text: "Summarize this." },
          ],
        },
      ],
    }

    expect(estimateAdditionalAttachmentTokens(payload)).toBeGreaterThan(2_500)
  })

  test("counts nested document attachments inside tool_result blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                {
                  type: "document",
                  source: {
                    type: "text",
                    data: "x".repeat(20_000),
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    expect(estimateAdditionalAttachmentTokens(payload)).toBe(5_000)
  })

  test("counts nested image attachments inside tool_result blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_img",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "A".repeat(240_000),
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    expect(estimateAdditionalAttachmentTokens(payload)).toBeGreaterThan(1_600)
  })

  test("ignores plain text conversations without attachments", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    }

    expect(estimateAdditionalAttachmentTokens(payload)).toBe(0)
  })
})
