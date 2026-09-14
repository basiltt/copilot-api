import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import {
  ChatCompletionStreamProtocolError,
  collectChatCompletionStream,
} from "~/services/copilot/collect-chat-completion-stream"

function event(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
}

function chunk(
  choices: Array<Record<string, unknown>>,
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "chat_stream",
    created: 42,
    model: "claude-sonnet-5",
    choices,
    ...(usage ? { usage } : {}),
  }
}

function response(events: Array<unknown>): Response {
  return new Response(
    events.map((item) => event(item)).join("") + event("[DONE]"),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function rejected(promise: Promise<unknown>): Promise<HTTPError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPError)
    return error as HTTPError
  }
  throw new Error("Expected promise to reject")
}

describe("one-shot Chat SSE envelopes", () => {
  test("accepts actual CAPI chunks that omit the optional object discriminator", async () => {
    const usage = {
      prompt_tokens: 6,
      completion_tokens: 2,
      total_tokens: 8,
    }
    const upstream = response([
      chunk([
        {
          index: 0,
          delta: { role: "assistant", content: "ok" },
        },
      ]),
      chunk([
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ]),
      chunk([], usage),
    ])

    const completion = await collectChatCompletionStream(
      upstream,
      new AbortController().signal,
    )

    expect(completion).toMatchObject({
      id: "chat_stream",
      model: "claude-sonnet-5",
      created: 42,
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage,
    })
  })

  test("accepts changing valid timestamps and retains the first value", async () => {
    const usage = {
      prompt_tokens: 8,
      completion_tokens: 3,
      total_tokens: 11,
    }
    const completion = await collectChatCompletionStream(
      response([
        chunk([
          {
            index: 0,
            delta: { role: "assistant", content: "first" },
          },
        ]),
        {
          ...chunk([
            {
              index: 0,
              delta: { content: " second" },
            },
          ]),
          created: 43,
        },
        {
          ...chunk(
            [
              {
                index: 0,
                delta: { content: null },
                finish_reason: "length",
              },
            ],
            usage,
          ),
          created: 43,
        },
      ]),
      new AbortController().signal,
    )

    expect(completion).toMatchObject({
      id: "chat_stream",
      model: "claude-sonnet-5",
      created: 42,
      choices: [
        {
          message: { role: "assistant", content: "first second" },
          finish_reason: "length",
        },
      ],
      usage,
    })
  })

  test("requires complete identity and validates per-chunk metadata", async () => {
    const cases: Array<{ events: Array<unknown>; message: string }> = [
      {
        events: [{ choices: [] }],
        message: "contained an invalid response id",
      },
      {
        events: [chunk([]), { object: "chat.completion", choices: [] }],
        message: "contained an invalid chunk object",
      },
      {
        events: [{ ...chunk([]), object: null }],
        message: "contained an invalid chunk object",
      },
      {
        events: [{ ...chunk([]), id: "" }],
        message: "contained an invalid response id",
      },
      {
        events: [{ ...chunk([]), model: 1 }],
        message: "contained an invalid response model",
      },
      {
        events: [{ ...chunk([]), created: "invalid" }],
        message: "contained an invalid response created timestamp",
      },
      {
        events: [
          {
            id: "chat_stream",
            model: "claude-sonnet-5",
            choices: [],
          },
        ],
        message: "contained an invalid response created timestamp",
      },
      {
        events: [{ ...chunk([]), choices: null }],
        message: "contained an invalid choices envelope",
      },
    ]

    for (const current of cases) {
      const error = await rejected(
        collectChatCompletionStream(
          response(current.events),
          new AbortController().signal,
        ),
      )

      expect(await error.response.clone().text()).toContain(current.message)
    }
  })

  for (const [key, value, reason] of [
    ["id", "PRIVATE_ID_VALUE", "changed_response_id"],
    ["model", "PRIVATE_MODEL_VALUE", "changed_response_model"],
  ] as const) {
    test(`classifies changed response ${key} without exposing its value`, async () => {
      const error = await rejected(
        collectChatCompletionStream(
          response([chunk([]), { ...chunk([]), [key]: value }]),
          new AbortController().signal,
        ),
      )

      expect(error).toBeInstanceOf(ChatCompletionStreamProtocolError)
      expect((error as ChatCompletionStreamProtocolError).reason).toBe(reason)
      expect(await error.response.clone().text()).not.toContain(value)
    })
  }
})
