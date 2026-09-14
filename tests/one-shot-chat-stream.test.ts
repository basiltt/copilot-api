import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { translateToAnthropic } from "~/routes/messages/non-stream-translation"
import { collectChatCompletionStream } from "~/services/copilot/collect-chat-completion-stream"

function event(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
}

function chunk(
  choices: Array<Record<string, unknown>>,
  usage?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    id: "chat_stream",
    object: "chat.completion.chunk",
    created: 42,
    model: "claude-sonnet-5",
    system_fingerprint: null,
    choices,
    ...(usage !== undefined ? { usage } : {}),
  }
}

function response(
  events: Array<unknown>,
  { done = true }: { done?: boolean } = {},
): Response {
  return new Response(
    events.map((item) => event(item)).join("") + (done ? event("[DONE]") : ""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject")
}

// eslint-disable-next-line max-lines-per-function -- Protocol cases share compact SSE fixture builders.
describe("one-shot Chat SSE collection", () => {
  test("preserves fragmented identities, argument bytes, reasoning, and usage", async () => {
    const upstream = response([
      chunk([
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "Check ",
            tool_calls: [
              {
                index: 2,
                id: "call_",
                type: "function",
                function: { name: "Re", arguments: '{"file_' },
              },
              {
                index: 0,
                id: "call_write",
                type: "function",
                function: { arguments: '{"file_path":"' },
              },
            ],
          },
          logprobs: null,
        },
      ]),
      chunk([], null),
      chunk([
        {
          index: 0,
          delta: {
            reasoning_text: "inputs.",
            content: "Ready.",
            tool_calls: [
              {
                index: 0,
                function: {
                  name: "Write",
                  arguments: 'src/a.ts","content":"ok"}',
                },
              },
              {
                index: 2,
                id: "read",
                function: { name: "ad", arguments: 'path":"src/a.ts"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ]),
      chunk([], {
        prompt_tokens: 30,
        completion_tokens: 9,
        total_tokens: 39,
        prompt_tokens_details: {
          cached_tokens: 7,
          cache_creation_tokens: 3,
        },
        completion_tokens_details: { reasoning_tokens: 2 },
      }),
    ])

    const completion = await collectChatCompletionStream(
      upstream,
      new AbortController().signal,
    )

    expect(completion.choices).toHaveLength(1)
    expect(completion.choices[0].message).toEqual({
      role: "assistant",
      content: "Ready.",
      reasoning_content: "Check inputs.",
      tool_calls: [
        {
          id: "call_write",
          type: "function",
          function: {
            name: "Write",
            arguments: '{"file_path":"src/a.ts","content":"ok"}',
          },
        },
        {
          id: "call_read",
          type: "function",
          function: {
            name: "Read",
            arguments: '{"file_path":"src/a.ts"}',
          },
        },
      ],
    })
    expect(completion.usage).toEqual({
      prompt_tokens: 30,
      completion_tokens: 9,
      total_tokens: 39,
      prompt_tokens_details: {
        cached_tokens: 7,
        cache_creation_tokens: 3,
      },
      completion_tokens_details: { reasoning_tokens: 2 },
    })
    expect(translateToAnthropic(completion).content[0]).toEqual({
      type: "thinking",
      thinking: "Check inputs.",
    })
  })

  test("stops at [DONE] without waiting for transport EOF", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let canceled = false
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
        },
        cancel() {
          canceled = true
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    controller.enqueue(
      new TextEncoder().encode(
        event(
          chunk([
            {
              index: 0,
              delta: { content: "done" },
              finish_reason: "stop",
              logprobs: null,
            },
          ]),
        ) + event("[DONE]"),
      ),
    )

    const completion = await collectChatCompletionStream(
      upstream,
      new AbortController().signal,
    )

    expect(completion.choices[0].message.content).toBe("done")
    expect(canceled).toBeTrue()
  })

  test("refusal suppresses buffered tool calls", async () => {
    const completion = await collectChatCompletionStream(
      response([
        chunk([
          {
            index: 0,
            delta: {
              refusal: "Cannot comply.",
              tool_calls: [
                {
                  index: 0,
                  id: "call_blocked",
                  type: "function",
                  function: { name: "Write", arguments: "{}" },
                },
              ],
            },
            finish_reason: "content_filter",
            logprobs: null,
          },
        ]),
      ]),
      new AbortController().signal,
    )

    const translated = translateToAnthropic(completion)
    expect(translated.stop_reason).toBe("refusal")
    expect(JSON.stringify(translated.content)).not.toContain("tool_use")
    expect(JSON.stringify(translated.content)).not.toContain("call_blocked")
  })

  test("length preserves exact partial tool arguments without completing them", async () => {
    const completion = await collectChatCompletionStream(
      response([
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_partial",
                  type: "function",
                  function: {
                    name: "Write",
                    arguments: '{"file_path":"src/a.ts"',
                  },
                },
              ],
            },
            finish_reason: "length",
            logprobs: null,
          },
        ]),
      ]),
      new AbortController().signal,
    )

    expect(
      completion.choices[0].message.tool_calls?.[0].function.arguments,
    ).toBe('{"file_path":"src/a.ts"')
    const translated = translateToAnthropic(completion)
    expect(translated.stop_reason).toBe("max_tokens")
    expect(JSON.stringify(translated.content)).not.toContain("partial_json")
  })

  test("allows incomplete tool identity only for refusal and truncation", async () => {
    for (const terminal of ["content_filter", "stop", "length"] as const) {
      const completion = await collectChatCompletionStream(
        response([
          chunk([
            {
              index: 0,
              delta: {
                ...(terminal !== "length" ? { refusal: "Declined." } : {}),
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"private":"sentinel"}' },
                  },
                ],
              },
              finish_reason: terminal,
              logprobs: null,
            },
          ]),
        ]),
        new AbortController().signal,
      )
      const translated = translateToAnthropic(completion)
      expect(translated.stop_reason).toBe(
        terminal === "length" ? "max_tokens" : "refusal",
      )
      expect(JSON.stringify(translated.content)).not.toContain("sentinel")
    }
  })

  test("accepts repeated complete identities without duplicating them", async () => {
    const completion = await collectChatCompletionStream(
      response([
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_same",
                  function: { name: "Write", arguments: "a" },
                },
              ],
            },
            finish_reason: null,
          },
        ]),
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_same",
                  function: { name: "Write", arguments: "a" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ]),
      ]),
      new AbortController().signal,
      { allowedToolNames: new Set(["Write"]) },
    )

    expect(completion.choices[0].message.tool_calls?.[0]).toEqual({
      id: "call_same",
      type: "function",
      function: { name: "Write", arguments: "aa" },
    })
  })

  test("keeps nullable optional usage details absent", async () => {
    const completion = await collectChatCompletionStream(
      response([
        chunk([
          {
            index: 0,
            delta: { content: "done" },
            finish_reason: "stop",
          },
        ]),
        chunk([], {
          prompt_tokens: 4,
          completion_tokens: 1,
          total_tokens: 5,
          prompt_tokens_details: {
            cached_tokens: null,
            cache_creation_tokens: null,
          },
          completion_tokens_details: {
            accepted_prediction_tokens: null,
            reasoning_tokens: null,
          },
        }),
      ]),
      new AbortController().signal,
    )

    expect(completion.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 1,
      total_tokens: 5,
    })
  })

  test("rejects conflicting complete tool identities", async () => {
    const error = await rejected(
      collectChatCompletionStream(
        response([
          chunk([
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_first",
                    function: { name: "Write", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ]),
          chunk([
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_second",
                    function: { name: "Read", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ]),
        ]),
        new AbortController().signal,
        { allowedToolNames: new Set(["Write", "Read"]) },
      ),
    )
    expect(error).toBeInstanceOf(HTTPError)
  })

  test("rejects conflicting complete tool names", async () => {
    const error = await rejected(
      collectChatCompletionStream(
        response([
          chunk([
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_same",
                    function: { name: "Write", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ]),
          chunk([
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "Read", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ]),
        ]),
        new AbortController().signal,
        { allowedToolNames: new Set(["Write", "Read"]) },
      ),
    )
    expect(error).toBeInstanceOf(HTTPError)
  })

  test("sanitizes error events after partial private tool data", async () => {
    const privateValue = "PRIVATE_TOOL_ARGUMENT_SENTINEL"
    const upstream = response([
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_private",
                function: { name: "Write", arguments: privateValue },
              },
            ],
          },
          finish_reason: null,
        },
      ]),
      {
        type: "error",
        error: {
          type: "rate_limit_error",
          code: "rate_limited",
          message: "Please retry later.",
        },
        choices: [{ privateValue }],
      },
    ])

    try {
      await collectChatCompletionStream(upstream, new AbortController().signal)
      throw new Error("Expected an HTTPError")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      if (!(error instanceof HTTPError)) throw error
      const body = await error.response.text()
      expect(body).toContain("rate_limited")
      expect(body).toContain("Please retry later.")
      expect(body).not.toContain(privateValue)
      expect(body).not.toContain("choices")
    }
  })

  test("bounds raw bytes before parsing an unterminated SSE event", async () => {
    let canceled = false
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`: ${"x".repeat(64)}`))
        },
        cancel() {
          canceled = true
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )

    const error = await rejected(
      collectChatCompletionStream(upstream, new AbortController().signal, {
        maxBytes: 16,
      }),
    )
    expect(error).toBeInstanceOf(HTTPError)
    expect(canceled).toBeTrue()
  })

  test.each([
    {
      name: "malformed JSON",
      upstream: response(["{"]),
    },
    {
      name: "missing terminal choice",
      upstream: response([
        chunk([
          {
            index: 0,
            delta: { content: "partial" },
            finish_reason: null,
            logprobs: null,
          },
        ]),
      ]),
    },
    {
      name: "data after terminal choice",
      upstream: response([
        chunk([
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
            logprobs: null,
          },
        ]),
        chunk([
          {
            index: 0,
            delta: { content: "late" },
            finish_reason: null,
            logprobs: null,
          },
        ]),
      ]),
    },
  ])("rejects $name", async ({ upstream }) => {
    const error = await rejected(
      collectChatCompletionStream(upstream, new AbortController().signal),
    )
    expect(error).toBeInstanceOf(HTTPError)
  })

  test("aborts a body read through the caller signal", async () => {
    const controller = new AbortController()
    let canceled = false
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const pending = collectChatCompletionStream(upstream, controller.signal)

    controller.abort(new Error("request canceled"))

    const error = await rejected(pending)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("request canceled")
    expect(canceled).toBeTrue()
  })
})
