import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { findInvalidEmbeddedImage } from "~/routes/messages/image-validation"

describe("findInvalidEmbeddedImage", () => {
  test("flags degenerate 1x1 PNG user images", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnSUswAAAAASUVORK5CYII=",
              },
            },
          ],
        },
      ],
    }

    expect(findInvalidEmbeddedImage(payload)).toEqual({
      mediaType: "image/png",
      width: 1,
      height: 1,
    })
  })

  test("allows normal PNG images", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAHVSURBVHhe7dGxaYMBFMTgf/9dvE8myBpOLzgwBORXqPiaK0/P6+f3nTseDvmughxTkGMKckxBjinIMQU5piDHFOSYj4O8nyf/wD+Xgkj451IQCf9cCiLhn0tBJPxzKYiEfy4FkfDPpSAS/rkURMI/l4JI+OdSEAn/XAoi4Z9LQST8cymIhH8uBZHwz6UgEv65FETCP5eCSPjnUhAJ/1wKIuGfS0Ek/HMpiIR/LgWR8M+lIBL+uRREwj+Xgkj451IQCf9cCiLhn0tBJPxzKYiEfy4FkfDPpSAS/rkURMI/l4JI+OdSEAn/XAoi4Z9LQST8cymIhH8uBZHwz6UgEv65FETCP5eCSPjnUhAJ/1wKIuGfS0Ek/HMpiIR/LgWR8M+lIBL+uRREwj+Xgkj451IQCf9cCiLhn0tBJPxzKYiEfy4FkfDPpSAS/rkURMI/l4JI+OdSEAn/XAoi4Z9LQST8cymIhH8uBZHwz6UgEv65FETCP5eCSPjnUhAJ/1wKIuGfS0Ek/HMpiIR/LgWR8M+lIBL+uRREwj+Xgkj451IQCf9cCiLhn0tBJPxzKYiEfy4FkfDPpSAS/rl8HCSOghxTkGMKckxBjinIMQU5piDHFOSYghzzBwck1lCKw6QmAAAAAElFTkSuQmCC",
              },
            },
          ],
        },
      ],
    }

    expect(findInvalidEmbeddedImage(payload)).toBeUndefined()
  })

  test("checks images nested inside tool results", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnSUswAAAAASUVORK5CYII=",
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    expect(findInvalidEmbeddedImage(payload)?.width).toBe(1)
  })
})
