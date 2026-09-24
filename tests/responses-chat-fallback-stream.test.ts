/* eslint-disable max-lines */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test"

import type { State } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { server } from "~/server"

const model: Model = {
  id: "claude-fable-5.1",
  name: "claude-fable-5.1",
  object: "model",
  vendor: "Anthropic",
  version: "1",
  model_picker_enabled: true,
  preview: false,
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    family: "claude-fable-5.1",
    tokenizer: "o200k_base",
    type: "chat",
    object: "model_capabilities",
    supports: { tool_calls: true },
    limits: {
      max_context_window_tokens: 200_000,
      max_prompt_tokens: 200_000,
      max_output_tokens: 16_384,
    },
  },
}

interface ParsedEvent {
  event?: string
  data: unknown
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let fetchMock: Mock<typeof fetch>
let originalState: State

beforeEach(() => {
  originalState = { ...state }
  Object.assign(state, {
    copilotToken: "test-token",
    vsCodeVersion: "1.0.0",
    accountType: "individual",
    models: { object: "list", data: [model] },
    manualApprove: false,
    rateLimitSeconds: undefined,
    rateLimitWait: false,
    burstCount: undefined,
    burstWindowSeconds: undefined,
  })
  fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected upstream request"),
  )
})

afterEach(() => {
  fetchMock.mockRestore()
  Object.assign(state, originalState)
})

function frame(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "chat_response",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  }
}

function usageFrame(): Record<string, unknown> {
  return {
    id: "chat_response",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 7 },
    },
  }
}

function streamResponse(
  frames: Array<Record<string, unknown> | string>,
  done = true,
): Response {
  const body = frames
    .map((value) =>
      typeof value === "string" ?
        `data: ${value}\n\n`
      : `data: ${JSON.stringify(value)}\n\n`,
    )
    .join("")
  return new Response(body + (done ? "data: [DONE]\n\n" : ""), {
    headers: { "content-type": "text/event-stream" },
  })
}

function request(
  tool: Record<string, unknown> = {
    type: "function",
    name: "list_sessions_and_chats",
    description: "List sessions",
  },
): Record<string, unknown> {
  return {
    model: model.id,
    input: "List the sessions",
    max_output_tokens: 128,
    stream: true,
    tools: [tool],
    tool_choice: "auto",
  }
}

async function send(
  frames: Array<Record<string, unknown> | string>,
  options: {
    body?: Record<string, unknown>
    done?: boolean
  } = {},
): Promise<Array<ParsedEvent>> {
  fetchMock.mockResolvedValueOnce(streamResponse(frames, options.done))
  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options.body ?? request()),
  })
  expect(response.status).toBe(200)
  const text = await response.text()
  return text
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1]
      const raw = block.match(/^data: (.+)$/m)?.[1]
      if (raw === undefined) throw new Error("Missing SSE data")
      return {
        ...(event ? { event } : {}),
        data: raw === "[DONE]" ? raw : (JSON.parse(raw) as unknown),
      }
    })
}

function eventData(
  events: Array<ParsedEvent>,
  type: string,
): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.event === type)
    .map((event) => event.data as Record<string, unknown>)
}

function completion(
  argumentsJson: string,
  finishReason: "stop" | "length" | "tool_calls" | "content_filter",
  options: {
    content?: string
    includeToolCall?: boolean
    name?: string
    reasoning?: string
    refusal?: string
  } = {},
): Record<string, unknown> {
  return {
    id: "chat_response",
    object: "chat.completion",
    created: 1,
    model: model.id,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: options.content ?? null,
          ...(options.reasoning !== undefined ?
            { reasoning_content: options.reasoning }
          : {}),
          ...(options.refusal !== undefined ?
            { refusal: options.refusal }
          : {}),
          ...(options.includeToolCall === false ?
            {}
          : {
              tool_calls: [
                {
                  id: "call_sessions",
                  type: "function",
                  function: {
                    name: options.name ?? "list_sessions_and_chats",
                    arguments: argumentsJson,
                  },
                },
              ],
            }),
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 7 },
    },
  }
}

async function sendJson(
  response: Record<string, unknown>,
  body: Record<string, unknown> = request(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  fetchMock.mockResolvedValueOnce(Response.json(response))
  const result = await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: false }),
  })
  return {
    status: result.status,
    body: (await result.json()) as Record<string, unknown>,
  }
}

describe("Responses Chat fallback stream integrity", () => {
  test("normalizes omitted arguments only for a completed declared no-input function", async () => {
    const events = await send([
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_sessions",
            type: "function",
            function: { name: "list_sessions_and_chats" },
          },
        ],
      }),
      frame({}, "tool_calls"),
      usageFrame(),
    ])

    const done = eventData(events, "response.function_call_arguments.done")
    expect(done).toHaveLength(1)
    expect(done[0].arguments).toBe("{}")
    const terminal = eventData(events, "response.completed")
    expect(terminal).toHaveLength(1)
    expect(JSON.stringify(terminal[0])).toContain('"arguments":"{}"')
    expect(eventData(events, "response.failed")).toHaveLength(0)
  })
})

describe("Responses Chat fallback JSON consistency", () => {
  test("normalizes the same completed declared no-input call", async () => {
    const result = await sendJson(completion("", "tool_calls"))
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      status: "completed",
      output: [
        {
          type: "function_call",
          status: "completed",
          arguments: "{}",
        },
      ],
      usage: { input_tokens_details: { cached_tokens: 7 } },
    })
  })

  test("keeps a truncated malformed call incomplete and non-completed", async () => {
    const result = await sendJson(completion("{", "length"))
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "function_call",
          status: "incomplete",
          arguments: "{",
        },
      ],
    })
  })

  test("rejects malformed completed JSON against the declared schema", async () => {
    const result = await sendJson(completion("{", "tool_calls"))
    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({
      type: "error",
      error: { type: "api_error" },
    })
  })

  test("rejects a completed call without an original tool contract", async () => {
    const result = await sendJson(completion("{}", "tool_calls"), {
      ...request(),
      tools: [],
    })
    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({
      type: "error",
      error: { type: "api_error" },
    })
  })

  test("refusal suppresses a malformed tool call", async () => {
    const result = await sendJson(
      completion("{", "content_filter", { refusal: "" }),
    )
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      status: "completed",
      output: [
        {
          type: "message",
          status: "completed",
          content: [{ type: "refusal", refusal: "" }],
        },
      ],
    })
    expect(JSON.stringify(result.body)).not.toContain("function_call")
  })

  test("preserves reasoning and content in ordered response items", async () => {
    const result = await sendJson(
      completion("", "stop", {
        reasoning: "Considered",
        content: "Answer",
        includeToolCall: false,
      }),
    )
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      status: "completed",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Considered" }],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "Answer" }],
        },
      ],
    })
  })
})

describe("Responses Chat fallback argument validation", () => {
  test("normalizes an explicit empty serialization for a declared no-input function", async () => {
    const events = await send([
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_sessions",
            type: "function",
            function: {
              name: "list_sessions_and_chats",
              arguments: "",
            },
          },
        ],
      }),
      frame({}, "tool_calls"),
    ])

    const deltas = eventData(events, "response.function_call_arguments.delta")
    const done = eventData(events, "response.function_call_arguments.done")
    expect(deltas[0].delta).toBe("{}")
    expect(done[0].arguments).toBe("{}")
  })

  test("normalizes omitted arguments for a closed empty object schema", async () => {
    const events = await send(
      [
        frame({
          tool_calls: [
            {
              index: 0,
              id: "call_sessions",
              type: "function",
              function: { name: "list_sessions_and_chats" },
            },
          ],
        }),
        frame({}, "tool_calls"),
      ],
      {
        body: request({
          type: "function",
          name: "list_sessions_and_chats",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        }),
      },
    )

    const done = eventData(events, "response.function_call_arguments.done")
    expect(done).toHaveLength(1)
    expect(done[0].arguments).toBe("{}")
  })

  test.each([
    {
      label: "parameterized",
      tool: {
        type: "function",
        name: "search",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      arguments: "",
    },
    {
      label: "open schema",
      tool: {
        type: "function",
        name: "search",
        parameters: {},
      },
      arguments: "",
    },
    {
      label: "whitespace",
      tool: {
        type: "function",
        name: "search",
      },
      arguments: " ",
    },
    {
      label: "non-object",
      tool: {
        type: "function",
        name: "search",
      },
      arguments: "null",
    },
    {
      label: "null wire value",
      tool: {
        type: "function",
        name: "search",
      },
      arguments: null,
    },
    {
      label: "numeric wire value",
      tool: {
        type: "function",
        name: "search",
      },
      arguments: 42,
    },
  ])(
    "does not normalize $label arguments",
    async ({ tool, arguments: args }) => {
      const events = await send(
        [
          frame({
            tool_calls: [
              {
                index: 0,
                id: "call_search",
                type: "function",
                function: { name: "search", arguments: args },
              },
            ],
          }),
          frame({}, "tool_calls"),
        ],
        { body: request(tool) },
      )

      expect(eventData(events, "response.failed")).toHaveLength(1)
      expect(
        eventData(events, "response.function_call_arguments.done"),
      ).toHaveLength(0)
    },
  )

  test("keeps a genuine empty object unchanged and uses one response id", async () => {
    const events = await send([
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_sessions",
            type: "function",
            function: {
              name: "list_sessions_and_chats",
              arguments: "{}",
            },
          },
        ],
      }),
      frame({}, "tool_calls"),
      usageFrame(),
    ])

    const created = eventData(events, "response.created")[0]
    const terminal = eventData(events, "response.completed")[0]
    const createdId = (created.response as Record<string, unknown>).id
    const terminalResponse = terminal.response as Record<string, unknown>
    expect(terminalResponse.id).toBe(createdId)
    expect(terminalResponse.usage).toEqual({
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      input_tokens_details: { cached_tokens: 7 },
    })
  })
})

describe("Responses Chat fallback completion state", () => {
  test("withholds incomplete tool completion and emits response.incomplete", async () => {
    const events = await send([
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_partial",
            type: "function",
            function: {
              name: "list_sessions_and_chats",
              arguments: '{"unterminated":',
            },
          },
        ],
      }),
      frame({}, "length"),
      usageFrame(),
    ])

    expect(
      eventData(events, "response.function_call_arguments.done"),
    ).toHaveLength(0)
    expect(eventData(events, "response.output_item.done")).toHaveLength(0)
    expect(eventData(events, "response.completed")).toHaveLength(0)
    const incomplete = eventData(events, "response.incomplete")
    expect(incomplete).toHaveLength(1)
    expect(incomplete[0]).toMatchObject({
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    })
  })

  test("reassembles identity metadata split across chunks", async () => {
    const events = await send([
      frame({
        tool_calls: [{ index: 3, id: "call_sessions", type: "function" }],
      }),
      frame({
        tool_calls: [
          {
            index: 3,
            function: {
              name: "list_sessions_",
              arguments: "{",
            },
          },
        ],
      }),
      frame({
        tool_calls: [
          {
            index: 3,
            function: {
              name: "and_chats",
              arguments: "}",
            },
          },
        ],
      }),
      frame({}, "tool_calls"),
      usageFrame(),
    ])

    const done = eventData(events, "response.function_call_arguments.done")
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({
      call_id: "call_sessions",
      name: "list_sessions_and_chats",
      arguments: "{}",
    })
  })

  test("accepts repeated identity metadata and rejects conflicts before output", async () => {
    const repeated = await send([
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_sessions",
            function: { name: "list_sessions_and_chats" },
          },
        ],
      }),
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_sessions",
            function: {
              name: "list_sessions_and_chats",
              arguments: "{}",
            },
          },
        ],
      }),
      frame({}, "tool_calls"),
    ])
    expect(
      eventData(repeated, "response.function_call_arguments.done"),
    ).toHaveLength(1)

    const conflicting = await send([
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_one",
            function: { name: "list_sessions_and_chats" },
          },
        ],
      }),
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_two",
            function: { arguments: "{}" },
          },
        ],
      }),
      frame({}, "tool_calls"),
    ])
    expect(eventData(conflicting, "response.failed")).toHaveLength(1)
    expect(eventData(conflicting, "response.output_item.added")).toHaveLength(0)
  })
})

describe("Responses Chat fallback upstream metadata", () => {
  test.each([
    { label: "response id", patch: { id: "changed_response" } },
    { label: "model", patch: { model: "changed_model" } },
  ])(
    "rejects a changed $label before emitting buffered output",
    async ({ patch }) => {
      const terminal = { ...frame({}, "stop"), ...patch }
      const events = await send([frame({ content: "partial" }), terminal])
      expect(eventData(events, "response.failed")).toHaveLength(1)
      expect(eventData(events, "response.output_item.added")).toHaveLength(0)
    },
  )

  test("rejects a choice without a delta", async () => {
    const invalid = frame({})
    invalid.choices = [{ index: 0, finish_reason: null }]
    const events = await send([invalid])
    expect(eventData(events, "response.failed")).toHaveLength(1)
    expect(eventData(events, "response.completed")).toHaveLength(0)
  })

  test("rejects an unknown Chat object tag", async () => {
    const invalid = frame({ content: "partial" })
    invalid.object = "unexpected"
    const events = await send([invalid])
    expect(eventData(events, "response.failed")).toHaveLength(1)
    expect(eventData(events, "response.output_item.added")).toHaveLength(0)
  })
})

describe("Responses Chat fallback output ordering", () => {
  test("preserves reasoning before later text", async () => {
    const events = await send([
      frame({ reasoning_content: "Considered" }),
      frame({ content: "Answer" }),
      frame({}, "stop"),
    ])
    const added = eventData(events, "response.output_item.added")
    expect(
      added.map((event) => (event.item as Record<string, unknown>).type),
    ).toEqual(["reasoning", "message"])
    expect(
      eventData(events, "response.reasoning_summary_text.done"),
    ).toMatchObject([{ text: "Considered" }])
    expect(eventData(events, "response.output_text.done")).toMatchObject([
      { text: "Answer" },
    ])
  })

  test("allocates stable output indexes for sparse tools around text", async () => {
    const events = await send(
      [
        frame({
          tool_calls: [
            {
              index: 7,
              id: "call_first",
              function: { name: "first", arguments: "{}" },
            },
          ],
        }),
        frame({ content: "explanation" }),
        frame({
          tool_calls: [
            {
              index: 2,
              id: "call_second",
              function: { name: "second", arguments: "{}" },
            },
          ],
        }),
        frame({}, "tool_calls"),
      ],
      {
        body: {
          ...request(),
          tools: [
            { type: "function", name: "first" },
            { type: "function", name: "second" },
          ],
        },
      },
    )

    const added = eventData(events, "response.output_item.added")
    expect(added.map((event) => event.output_index)).toEqual([0, 1, 2])
    const terminal = eventData(events, "response.completed")[0]
    const output = (terminal.response as Record<string, unknown>)
      .output as Array<Record<string, unknown>>
    expect(output.map((item) => item.type)).toEqual([
      "function_call",
      "message",
      "function_call",
    ])
  })

  test("keeps text-before-tool indexes stable", async () => {
    const events = await send([
      frame({ content: "explanation" }),
      frame({
        tool_calls: [
          {
            index: 5,
            id: "call_sessions",
            function: {
              name: "list_sessions_and_chats",
              arguments: "{}",
            },
          },
        ],
      }),
      frame({}, "tool_calls"),
    ])
    const terminal = eventData(events, "response.completed")[0]
    const output = (terminal.response as Record<string, unknown>)
      .output as Array<Record<string, unknown>>
    expect(output.map((item) => item.type)).toEqual([
      "message",
      "function_call",
    ])
    expect(
      eventData(events, "response.output_item.added").map(
        (event) => event.output_index,
      ),
    ).toEqual([0, 1])
  })

  test("validates every completed parallel call before emitting tool completion", async () => {
    const events = await send(
      [
        frame({
          tool_calls: [
            {
              index: 0,
              id: "call_good",
              type: "function",
              function: { name: "first", arguments: "{}" },
            },
            {
              index: 4,
              id: "call_bad",
              type: "function",
              function: { name: "second", arguments: "{" },
            },
          ],
        }),
        frame({}, "tool_calls"),
      ],
      {
        body: {
          ...request(),
          tools: [
            {
              type: "function",
              name: "first",
              parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
            {
              type: "function",
              name: "second",
              parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        },
      },
    )

    expect(eventData(events, "response.failed")).toHaveLength(1)
    expect(eventData(events, "response.output_item.added")).toHaveLength(0)
    expect(eventData(events, "response.output_item.done")).toHaveLength(0)
  })

  test("rejects translated tool-name collisions before calling upstream", async () => {
    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request(),
        tools: [
          { type: "function", name: "duplicate" },
          { type: "function", name: "duplicate" },
        ],
      }),
    })
    expect(response.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })
})

describe("Responses Chat fallback failure handling", () => {
  test("fails malformed frames instead of skipping them", async () => {
    const events = await send(["{"])
    const failed = eventData(events, "response.failed")
    expect(failed).toHaveLength(1)
    expect(failed[0].sequence_number).toBe(2)
    const failedResponse = failed[0].response as Record<string, unknown>
    expect(typeof failedResponse.id).toBe("string")
    expect((failedResponse.id as string).startsWith("resp_")).toBe(true)
    expect(failed[0]).toMatchObject({
      response: {
        status: "failed",
        output: [],
        error: {
          code: "invalid_tool_call",
        },
      },
    })
    expect(eventData(events, "response.completed")).toHaveLength(0)
  })

  test("refusal suppresses partial tool completion", async () => {
    const events = await send([
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_partial",
            function: {
              name: "list_sessions_and_chats",
              arguments: "{",
            },
          },
        ],
      }),
      frame({ refusal: "Declined" }),
      frame({}, "content_filter"),
      usageFrame(),
    ])

    expect(
      eventData(events, "response.function_call_arguments.done"),
    ).toHaveLength(0)
    expect(
      eventData(events, "response.output_item.added").some(
        (event) =>
          (event.item as Record<string, unknown>).type === "function_call",
      ),
    ).toBe(false)
    expect(eventData(events, "response.refusal.done")).toHaveLength(1)
    expect(eventData(events, "response.completed")).toHaveLength(1)
  })

  test("an empty refusal suppresses tools and densifies remaining output", async () => {
    const events = await send([
      frame({
        tool_calls: [
          {
            index: 9,
            id: "call_partial",
            function: {
              name: "list_sessions_and_chats",
              arguments: "{}",
            },
          },
        ],
      }),
      frame({ refusal: "" }),
      frame({}, "content_filter"),
    ])

    const added = eventData(events, "response.output_item.added")
    expect(added).toHaveLength(1)
    expect(added[0].output_index).toBe(0)
    expect((added[0].item as Record<string, unknown>).type).toBe("message")
    const terminal = eventData(events, "response.completed")[0]
    const output = (terminal.response as Record<string, unknown>)
      .output as Array<Record<string, unknown>>
    expect(output).toHaveLength(1)
    expect(output[0].type).toBe("message")
  })

  test("an upstream error outranks buffered output", async () => {
    const events = await send([
      frame({ content: "partial" }),
      {
        id: "chat_response",
        object: "chat.completion.chunk",
        created: 1,
        model: model.id,
        choices: [],
        error: { code: "policy_denied", message: "Denied" },
      },
    ])
    const failed = eventData(events, "response.failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      response: {
        error: {
          code: "policy_denied",
          message: "Denied",
        },
      },
    })
    expect(eventData(events, "response.output_item.added")).toHaveLength(0)
    expect(eventData(events, "response.completed")).toHaveLength(0)
  })

  test("fails repeated terminal metadata without emitting two terminals", async () => {
    const events = await send([
      frame({ content: "complete" }),
      frame({}, "stop"),
      frame({}, "stop"),
    ])
    expect(eventData(events, "response.failed")).toHaveLength(1)
    expect(eventData(events, "response.completed")).toHaveLength(0)
    expect(eventData(events, "response.incomplete")).toHaveLength(0)
  })

  test("fails a stream that ends without a finish reason", async () => {
    const events = await send([frame({ content: "partial" })], { done: false })
    expect(eventData(events, "response.failed")).toHaveLength(1)
    expect(eventData(events, "response.completed")).toHaveLength(0)
  })

  test("cancels the upstream reader when the downstream stream closes", async () => {
    const canceled = barrier()
    let upstreamSignal: AbortSignal | undefined
    fetchMock.mockImplementationOnce(
      Object.assign(
        (_url: string | URL | Request, init?: RequestInit) => {
          upstreamSignal = init?.signal ?? undefined
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify(frame({ content: "partial" }))}\n\n`,
                    ),
                  )
                },
                cancel() {
                  canceled.resolve()
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
          )
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    })
    if (!response.body) throw new Error("Missing response body")
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()
    await canceled.promise
    expect(upstreamSignal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("accepts EOF after a finish reason and emits one terminal", async () => {
    const events = await send(
      [frame({ content: "complete" }), frame({}, "stop"), usageFrame()],
      { done: false },
    )
    expect(eventData(events, "response.completed")).toHaveLength(1)
    expect(eventData(events, "response.failed")).toHaveLength(0)
    const sequence = events
      .filter((event) => event.event)
      .map(
        (event) => (event.data as { sequence_number: number }).sequence_number,
      )
    expect(sequence).toEqual(sequence.map((_, index) => index))
  })
})
