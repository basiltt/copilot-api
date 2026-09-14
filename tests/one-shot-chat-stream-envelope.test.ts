import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { collectChatCompletionStream } from "~/services/copilot/collect-chat-completion-stream"

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

  test("requires complete immutable identity and validates optional object", async () => {
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
})
