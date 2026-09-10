import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { state } from "~/lib/state"
import {
  createChatCompletions,
  createOneShotCompletion,
  getFinalUpstreamRequestShape,
} from "~/services/copilot/create-chat-completions"

const originalState = { ...state }
let bodies: Array<Record<string, unknown>>
let urls: Array<string>
let fetchMock: ReturnType<typeof mock>

function payload(stream: boolean): ChatCompletionsPayload {
  return {
    model: "claude-sonnet-5",
    messages: [
      { role: "user", content: "Produce a bounded fixture response." },
    ],
    max_tokens: 64_000,
    stream,
  }
}

function completionResponse(): Response {
  return Response.json({
    id: "chat_wire",
    object: "chat.completion",
    model: "claude-sonnet-5",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "done" },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

beforeEach(() => {
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "test-token",
    vsCodeVersion: "1.0.0",
  })
  bodies = []
  urls = []
  fetchMock = mock(
    (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body !== "string")
        throw new Error("Expected a serialized JSON body")
      urls.push(url instanceof Request ? url.url : url.toString())
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      const request = bodies.at(-1)
      if (request?.stream === true) {
        return Promise.resolve(
          new Response("data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
        )
      }
      return Promise.resolve(completionResponse())
    },
  )
  Object.assign(globalThis, { fetch: fetchMock })
})

afterEach(() => {
  Object.assign(state, originalState)
  mock.restore()
})

function expectSonnetChatWire(
  body: Record<string, unknown>,
  stream: boolean,
): void {
  expect(body).toMatchObject({
    model: "claude-sonnet-5",
    max_tokens: 64_000,
    stream,
  })
  expect(body).not.toHaveProperty("max_completion_tokens")
  expect(body).not.toHaveProperty("max_output_tokens")
}

describe("Sonnet output budget final wire shape", () => {
  test("direct non-streaming uses chat completions max_tokens unchanged", async () => {
    const response = await createChatCompletions(payload(false))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(urls[0]).toEndWith("/chat/completions")
    expectSonnetChatWire(bodies[0], false)
    expect(getFinalUpstreamRequestShape(response)).toEqual({
      endpoint: "chat_completions",
      tokenField: "max_tokens",
      tokenValue: 64_000,
      stream: false,
      oneShot: false,
      nativeRouting: "not_applicable",
    })
  })

  test("direct SSE uses chat completions max_tokens unchanged", async () => {
    const response = await createChatCompletions(payload(true))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(urls[0]).toEndWith("/chat/completions")
    expectSonnetChatWire(bodies[0], true)
    expect(getFinalUpstreamRequestShape(response)).toEqual({
      endpoint: "chat_completions",
      tokenField: "max_tokens",
      tokenValue: 64_000,
      stream: true,
      oneShot: false,
      nativeRouting: "not_applicable",
    })
  })

  test("buffered one-shot preserves the budget and disables upstream streaming", async () => {
    const response = await createOneShotCompletion(payload(true), {
      usesResponses: false,
      signal: new AbortController().signal,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(urls[0]).toEndWith("/chat/completions")
    expectSonnetChatWire(bodies[0], false)
    expect(getFinalUpstreamRequestShape(response)).toEqual({
      endpoint: "chat_completions",
      tokenField: "max_tokens",
      tokenValue: 64_000,
      stream: false,
      oneShot: true,
      nativeRouting: "not_applicable",
    })
  })
})
