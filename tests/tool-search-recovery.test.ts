/* eslint-disable max-lines */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { knownModelMetadata } from "~/lib/known-models"
import { state } from "~/lib/state"
import { messageRoutes } from "~/routes/messages/route"
import {
  createToolNameMapFromAnthropicPayload,
  toOpenAIToolName,
} from "~/routes/messages/tool-name-mapping"
import {
  TOOL_SEARCH_RECOVERY_TIMEOUT_MS,
  usesToolSearchRecovery,
} from "~/routes/messages/tool-search-recovery"
import { configureToolSearchRecovery } from "~/start"

const app = new Hono().route("/v1/messages", messageRoutes)
const originalState = { ...state }
const originalEnv = process.env.TOOL_SEARCH_RECOVERY
const originalSetTimeout = globalThis.setTimeout
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let timerSpy:
  | ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>
  | undefined
let logs: Array<ReturnType<typeof spyOn<typeof consola, "debug">>> = []
let bodies: Array<ChatCompletionsPayload> = []
let replies: Array<() => Response> = []

const schema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    max_results: { type: "integer", minimum: 1, maximum: 20 },
  },
  required: ["query"],
  additionalProperties: false,
}

function payload(
  stream = false,
  inputSchema: Record<string, unknown> = schema,
): AnthropicMessagesPayload {
  return {
    model: "claude-fable-5.1",
    messages: [{ role: "user", content: "Find and load the matching tool." }],
    max_tokens: 256,
    stream,
    tools: [
      { name: "ToolSearch", input_schema: inputSchema },
      {
        name: "WebFetch",
        defer_loading: true,
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["url", "prompt"],
        },
      },
    ],
    tool_choice: { type: "auto" },
  }
}

function completion(
  raw: string,
  {
    id = "search_original",
    name = "ToolSearch",
    model = "claude-fable-5.1",
    content = null,
    finishReason = "tool_calls",
  }: {
    id?: string
    name?: string
    model?: string
    content?: string | null
    finishReason?: "stop" | "length" | "tool_calls" | "content_filter"
  } = {},
): ChatCompletionResponse {
  return {
    id: "chat_search",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: {
          role: "assistant",
          content,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: raw },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25,
      prompt_tokens_details: { cached_tokens: 3 },
    },
  }
}

function repaired(raw: string): ChatCompletionResponse {
  const result = completion(raw, { id: "search_repair" })
  result.usage = {
    prompt_tokens: 7,
    completion_tokens: 2,
    total_tokens: 9,
    prompt_tokens_details: { cached_tokens: 1 },
  }
  return result
}

function queue(...responses: Array<ChatCompletionResponse | Response>) {
  replies = responses.map(
    (response) => () =>
      response instanceof Response ? response : Response.json(response),
  )
}

function send(body = payload(), signal?: AbortSignal) {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
}

function setRecoverySetting(value: string | undefined) {
  if (value === undefined) delete process.env.TOOL_SEARCH_RECOVERY
  else process.env.TOOL_SEARCH_RECOVERY = value
}

beforeEach(() => {
  bodies = []
  replies = []
  Object.assign(state, {
    toolSearchRecovery: true,
    writeToolRecovery: false,
    structuredOutputRecovery: false,
    copilotToken: "test-token",
    vsCodeVersion: "1.0",
    webSearchProvider: "off",
    rateLimitSeconds: undefined,
    burstCount: undefined,
    burstMinSpacingMs: 0,
  })
  const model = knownModelMetadata("claude-fable-5.1")
  if (!model) throw new Error("Expected model")
  model.supported_endpoints = ["/chat/completions"]
  state.models = { object: "list", data: [model] }
  logs = (["debug", "warn", "error", "info"] as const).map((method) =>
    spyOn(consola, method).mockImplementation(
      Object.assign(() => undefined, { raw: () => undefined }),
    ),
  )
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON request body")
        bodies.push(JSON.parse(init.body) as ChatCompletionsPayload)
        const next = replies.shift()
        if (!next) throw new Error("Unexpected extra upstream request")
        return Promise.resolve(next())
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  fetchSpy.mockClear()
})

afterEach(() => {
  fetchSpy.mockRestore()
  timerSpy?.mockRestore()
  timerSpy = undefined
  for (const log of logs) log.mockRestore()
  for (const key of Object.keys(state)) {
    if (!Object.hasOwn(originalState, key)) Reflect.deleteProperty(state, key)
  }
  Object.assign(state, originalState)
  setRecoverySetting(originalEnv)
})

// eslint-disable-next-line max-lines-per-function -- Request fixtures exercise the complete eligibility and regeneration contract together.
describe("bounded ToolSearch argument recovery", () => {
  test("repairs against the exact schema while preserving ID, supplied limits, text, and usage", async () => {
    const request = payload()
    request.tools?.push(
      {
        name: "Write",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            content: { type: "string" },
          },
          required: ["file_path", "content"],
        },
      },
      {
        name: "StructuredOutput",
        input_schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
      { type: "bash_20250124", name: "bash" },
    )
    state.writeToolRecovery = true
    state.structuredOutputRecovery = true
    queue(
      completion('{"max_results":7}', {
        content: "I will load the relevant tool.",
      }),
      repaired('{"max_results":7,"query":"select:WebFetch"}'),
    )

    const response = await send(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: "msg_chat_search",
      model: "claude-fable-5.1",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 23,
        output_tokens: 7,
        cache_read_input_tokens: 4,
      },
      content: [
        { type: "text", text: "I will load the relevant tool." },
        {
          type: "tool_use",
          id: "search_original",
          name: "ToolSearch",
          input: { max_results: 7, query: "select:WebFetch" },
        },
      ],
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(bodies[1].model).toBe("claude-fable-5.1")
    expect(bodies[1].tool_choice).toBe("auto")
    expect(bodies[1].tools?.map((tool) => tool.function.name)).toEqual([
      "ToolSearch",
    ])
    expect(bodies[1].tools?.[0].function.parameters).toEqual(schema)
    expect(JSON.stringify(bodies[1].messages)).toContain(
      "UNTRUSTED_EXISTING_ARGUMENTS",
    )
  })

  test("valid output uses one call and startup parsing is explicit", async () => {
    setRecoverySetting(undefined)
    configureToolSearchRecovery()
    expect(state.toolSearchRecovery).toBe(false)
    setRecoverySetting("1")
    configureToolSearchRecovery()
    expect(state.toolSearchRecovery).toBe(true)
    setRecoverySetting("true")
    expect(configureToolSearchRecovery).toThrow("must be 0 or 1")

    queue(completion('{"query":"select:WebFetch","max_results":3}'))
    const response = await send()
    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const noSearch = completion("{}")
    noSearch.choices[0].finish_reason = "stop"
    noSearch.choices[0].message.content = "No discovery is needed."
    noSearch.choices[0].message.tool_calls = undefined
    queue(noSearch)
    const plain = await send()
    expect(plain.status).toBe(200)
    expect(await plain.text()).toContain("No discovery is needed.")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test.each([
    {
      name: "local reference",
      schema: {
        type: "object",
        properties: { query: { $ref: "#/$defs/query" } },
        required: ["query"],
        additionalProperties: false,
        $defs: { query: { type: "string", pattern: "^select:" } },
      },
      repaired: '{"query":"select:WebFetch"}',
    },
    {
      name: "union",
      schema: {
        type: "object",
        properties: {
          query: {
            oneOf: [
              { type: "string", pattern: "^select:" },
              { type: "string", pattern: "^kind:" },
            ],
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      repaired: '{"query":"kind:network"}',
    },
  ])("supports the client's unchanged $name schema", async (fixture) => {
    queue(completion("{}"), repaired(fixture.repaired))
    const response = await send(payload(false, fixture.schema))
    expect(response.status).toBe(200)
    expect(bodies[1].tools?.[0].function.parameters).toEqual(fixture.schema)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("preserves logical identity across aliases and tool_reference follow-up", async () => {
    const request = payload()
    request.tools?.unshift({
      name: "ToolSearch.",
      input_schema: schema,
    })
    const map = createToolNameMapFromAnthropicPayload(request)
    const initialName = toOpenAIToolName("ToolSearch", map)
    expect(initialName).not.toBe("ToolSearch")
    queue(
      completion("{}", { name: initialName }),
      repaired('{"query":"select:WebFetch"}'),
    )
    const response = await send(request)
    const first = (await response.json()) as {
      content: Array<Record<string, unknown>>
    }
    expect(first.content).toContainEqual({
      type: "tool_use",
      id: "search_original",
      name: "ToolSearch",
      input: { query: "select:WebFetch" },
    })

    const followUp = payload()
    followUp.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "search_original",
            name: "ToolSearch",
            input: { query: "select:WebFetch" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "search_original",
            content: [{ type: "tool_reference", tool_name: "WebFetch" }],
          },
        ],
      },
    ]
    queue({
      ...completion('{"url":"https://example.invalid","prompt":"read"}', {
        id: "loaded_call",
        name: "WebFetch",
      }),
      choices: [
        {
          ...completion("{}").choices[0],
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "loaded_call",
                type: "function",
                function: {
                  name: "WebFetch",
                  arguments:
                    '{"url":"https://example.invalid","prompt":"read"}',
                },
              },
            ],
          },
        },
      ],
    })
    const loaded = await send(followUp)
    expect(loaded.status).toBe(200)
    expect(await loaded.text()).toContain('"name":"WebFetch"')
    expect(bodies[2].tools?.map((tool) => tool.function.name)).toContain(
      "WebFetch",
    )
    expect(JSON.stringify(bodies[2].messages)).toContain(
      "[Tool loaded: WebFetch]",
    )
  })

  test("buffers original SSE once and keeps other recovery permissions original-mode bound", async () => {
    const request = payload(true)
    request.tools?.push(
      {
        name: "Write",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            content: { type: "string" },
          },
          required: ["file_path", "content"],
        },
      },
      {
        name: "StructuredOutput",
        input_schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    )
    state.writeToolRecovery = true
    state.structuredOutputRecovery = true
    expect(usesToolSearchRecovery(request)).toBe(true)
    queue(completion("{}"), repaired('{"query":"select:WebFetch"}'))

    const response = await send(request)
    const output = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(output.match(/event: message_start/g)).toHaveLength(1)
    expect(output.match(/event: message_stop/g)).toHaveLength(1)
    expect(output).toContain('"name":"ToolSearch"')
    expect(output).toContain(String.raw`\"query\":\"select:WebFetch\"`)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(bodies.every((body) => body.stream === false)).toBe(true)
  })

  test.each([
    {
      stream: false,
      serverTool: {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 1,
      },
    },
    {
      stream: true,
      serverTool: {
        type: "web_search_20260318",
        name: "web_search",
        max_uses: 1,
        allowed_callers: ["direct"],
      },
    },
  ])(
    "repairs ToolSearch without executing declared server search (stream=$stream)",
    async ({ stream, serverTool }) => {
      state.webSearchProvider = "copilot"
      const request = payload(stream)
      request.tools?.push(serverTool)
      queue(completion("{}"), repaired('{"query":"select:WebFetch"}'))

      const response = await send(request)
      const output = await response.text()
      expect(response.status).toBe(200)
      expect(output).toContain("ToolSearch")
      expect(output).toContain("select:WebFetch")
      expect(output).not.toContain("server_tool_use")
      expect(output).not.toContain("web_search_tool_result")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(
        bodies[0].tools?.some((tool) =>
          tool.function.name.startsWith("__copilot_web_search"),
        ),
      ).toBe(true)
      expect(bodies[1].tools?.map((tool) => tool.function.name)).toEqual([
        "ToolSearch",
      ])
      expect(bodies.every((body) => body.stream === false)).toBe(true)
    },
  )

  test("server-search buffering cannot enable Write recovery for an original stream", async () => {
    const request = payload(true)
    request.tools?.push(
      {
        name: "Write",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            content: { type: "string" },
          },
          required: ["file_path", "content"],
        },
      },
      {
        name: "StructuredOutput",
        input_schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 1,
      },
    )
    state.webSearchProvider = "copilot"
    state.writeToolRecovery = true
    state.structuredOutputRecovery = true
    queue(
      completion('{"file_path":"generated.ts"}', {
        name: "Write",
      }),
    )

    const response = await send(request)
    const output = await response.text()
    expect(response.status).toBe(200)
    expect(output).toContain('"type":"error"')
    expect(output).not.toContain('"type":"tool_use"')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("mixed actual server-search and ToolSearch calls remain strict", async () => {
    state.webSearchProvider = "copilot"
    const request = payload(false)
    request.tools?.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 1,
    })
    fetchSpy.mockImplementation(
      Object.assign(
        (_url: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("Missing body")
          const body = JSON.parse(init.body) as ChatCompletionsPayload
          bodies.push(body)
          const serverSearch = body.tools?.find((tool) =>
            tool.function.name.startsWith("__copilot_web_search"),
          )
          if (!serverSearch) throw new Error("Expected server search tool")
          const result = completion("{}")
          result.choices[0].message.tool_calls?.push({
            id: "server_search_call",
            type: "function",
            function: {
              name: serverSearch.function.name,
              arguments: '{"query":"current news"}',
            },
          })
          return Promise.resolve(Response.json(result))
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )

    const response = await send(request)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("web_search_tool_result")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test.each([
    "disabled",
    "typed hosted tool",
    "malformed",
    "length",
    "mixed calls",
    "acknowledged call",
  ])("does not regenerate ineligible %s output", async (kind) => {
    const request = payload()
    const result = completion("{}")
    if (kind === "disabled") state.toolSearchRecovery = false
    if (kind === "typed hosted tool") {
      request.tools = [
        {
          type: "tool_search_tool_bm25_20251119",
          name: "ToolSearch",
        },
      ]
    }
    if (kind === "malformed") {
      const call = result.choices[0].message.tool_calls?.[0]
      if (!call) throw new Error("Expected ToolSearch call")
      call.function.arguments = "{"
    }
    if (kind === "length") result.choices[0].finish_reason = "length"
    if (kind === "mixed calls") {
      result.choices[0].message.tool_calls?.push({
        id: "other_call",
        type: "function",
        function: { name: "WebFetch", arguments: "{}" },
      })
    }
    if (kind === "acknowledged call") {
      request.messages.unshift(
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "search_original",
              name: "ToolSearch",
              input: { query: "previous" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "search_original",
              content: "done",
            },
          ],
        },
      )
    }
    queue(result)
    const response = await send(request)
    expect(response.status).toBe(kind === "typed hosted tool" ? 400 : 502)
    expect(fetchSpy).toHaveBeenCalledTimes(kind === "typed hosted tool" ? 0 : 1)
  })

  test("refusal and upstream policy errors never regenerate or emit tools", async () => {
    const refusal = completion("{}")
    refusal.choices[0].message.refusal = ""
    queue(refusal)
    const refused = await send()
    const refusedBody = await refused.text()
    expect(refused.status).toBe(200)
    expect(refusedBody).toContain('"stop_reason":"refusal"')
    expect(refusedBody).not.toContain('"type":"tool_use"')

    queue(
      Response.json(
        { error: { code: "policy", message: "Policy denied" } },
        { status: 403 },
      ),
    )
    const policy = await send()
    expect(policy.status).toBe(403)
    expect(await policy.text()).toContain("Policy denied")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test.each([
    "wrong tool",
    "different model",
    "mixed calls",
    "changed supplied limit",
    "invalid supplied limit",
    "invalid again",
    "prose",
    "refusal",
  ])("rejects regeneration with %s and never loops", async (kind) => {
    const repair = repaired('{"max_results":7,"query":"select:WebFetch"}')
    const call = repair.choices[0].message.tool_calls?.[0]
    if (!call) throw new Error("Expected ToolSearch call")
    if (kind === "wrong tool") call.function.name = "WebFetch"
    if (kind === "different model") repair.model = "another-model"
    if (kind === "mixed calls")
      repair.choices[0].message.tool_calls?.push({ ...call, id: "extra" })
    if (kind === "changed supplied limit")
      call.function.arguments = '{"max_results":8,"query":"select:WebFetch"}'
    if (kind === "invalid supplied limit")
      call.function.arguments = '{"max_results":99,"query":"select:WebFetch"}'
    if (kind === "invalid again") call.function.arguments = "{}"
    if (kind === "prose") repair.choices[0].message.content = "Loaded."
    if (kind === "refusal") repair.choices[0].message.refusal = "Declined"
    queue(
      completion(
        kind === "invalid supplied limit" ? '{"max_results":99}' : (
          '{"max_results":7}'
        ),
      ),
      repair,
    )
    const response = await send()
    expect(response.status).toBe(502)
    expect(await response.text()).toContain("no further automatic attempt")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("regeneration policy details retain status and private values never enter logs", async () => {
    const secret = "PRIVATE_DISCOVERY_QUERY"
    queue(
      completion(JSON.stringify({ max_results: 7, note: secret })),
      Response.json(
        { error: { code: "policy", message: "Correction policy denied" } },
        { status: 403 },
      ),
    )
    const response = await send()
    expect(response.status).toBe(403)
    expect(await response.text()).toContain("Correction policy denied")
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    expect(captured).toContain("ToolSearch schema mismatch")
    expect(captured).not.toContain(secret)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

function captureDeadline() {
  let expire: (() => void) | undefined
  timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: Array<unknown>) => void,
    delay?: number,
    ...args: Array<unknown>
  ) => {
    if (
      delay === TOOL_SEARCH_RECOVERY_TIMEOUT_MS
      && typeof callback === "function"
    ) {
      expire = () => callback()
    }
    return originalSetTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  return () => {
    expect(TOOL_SEARCH_RECOVERY_TIMEOUT_MS).toBe(20_000)
    if (!expire) throw new Error("Recovery deadline not installed")
    expire()
  }
}

describe("ToolSearch recovery deadline and isolation", () => {
  test.each(["headers", "body"])(
    "deadline aborts regeneration during %s",
    async (stage) => {
      const expire = captureDeadline()
      let repairSignal: AbortSignal | undefined
      let bodyCanceled = false
      const entered = Promise.withResolvers<boolean>()
      let calls = 0
      fetchSpy.mockImplementation(
        Object.assign(
          (_url: string | URL | Request, init?: RequestInit) => {
            calls++
            if (calls === 1)
              return Promise.resolve(Response.json(completion("{}")))
            repairSignal = init?.signal ?? undefined
            if (stage === "headers") {
              entered.resolve(true)
              return new Promise<Response>((_resolve, reject) => {
                repairSignal?.addEventListener(
                  "abort",
                  () => reject(new Error("Transport aborted")),
                  { once: true },
                )
              })
            }
            return Promise.resolve(
              new Response(
                new ReadableStream({
                  pull() {
                    entered.resolve(true)
                  },
                  cancel() {
                    bodyCanceled = true
                  },
                }),
              ),
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const pending = send()
      await entered.promise
      expire()
      const response = await pending
      expect(response.status).toBe(502)
      expect(await response.text()).toContain("timed out after 20 seconds")
      expect(repairSignal?.aborted).toBe(true)
      if (stage === "body") expect(bodyCanceled).toBe(true)
      expect(calls).toBe(2)
    },
  )

  test("downstream cancellation aborts regeneration", async () => {
    const entered = Promise.withResolvers<boolean>()
    let repairSignal: AbortSignal | undefined
    let bodyCanceled = false
    let calls = 0
    fetchSpy.mockImplementation(
      Object.assign(
        (_url: string | URL | Request, init?: RequestInit) => {
          calls++
          if (calls === 1)
            return Promise.resolve(Response.json(completion("{}")))
          repairSignal = init?.signal ?? undefined
          return Promise.resolve(
            new Response(
              new ReadableStream({
                pull() {
                  entered.resolve(true)
                },
                cancel() {
                  bodyCanceled = true
                },
              }),
            ),
          )
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    const controller = new AbortController()
    const pending = send(payload(), controller.signal)
    await entered.promise
    controller.abort(new Error("Client disconnected"))
    await pending
    await Promise.resolve()
    expect(repairSignal?.aborted).toBe(true)
    expect(bodyCanceled).toBe(true)
    expect(calls).toBe(2)
  })

  test("concurrent requests retain independent schemas and call IDs", async () => {
    const firstSchema = {
      ...schema,
      properties: {
        query: { type: "string", const: "first" },
        max_results: schema.properties.max_results,
      },
    }
    const secondSchema = {
      ...schema,
      properties: {
        query: { type: "string", const: "second" },
        max_results: schema.properties.max_results,
      },
    }
    const repairResolvers: Array<(value: Response) => void> = []
    const bothEntered = Promise.withResolvers<boolean>()
    fetchSpy.mockImplementation(
      Object.assign(
        (_url: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("Missing body")
          const body = JSON.parse(init.body) as ChatCompletionsPayload
          bodies.push(body)
          const serialized = JSON.stringify(body.messages)
          if (!serialized.includes("UNTRUSTED_EXISTING_ARGUMENTS")) {
            const requiredQuery = (
              body.tools?.[0].function.parameters.properties as {
                query: { const: string }
              }
            ).query.const
            return Promise.resolve(
              Response.json(
                completion("{}", { id: `${requiredQuery}_original` }),
              ),
            )
          }
          return new Promise<Response>((resolve) => {
            repairResolvers.push(resolve)
            if (repairResolvers.length === 2) bothEntered.resolve(true)
          })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    const first = send(payload(false, firstSchema))
    const second = send(payload(false, secondSchema))
    await bothEntered.promise
    expect(repairResolvers).toHaveLength(2)
    repairResolvers[1](Response.json(repaired('{"query":"second"}')))
    repairResolvers[0](Response.json(repaired('{"query":"first"}')))
    const [firstResponse, secondResponse] = await Promise.all([first, second])
    const firstBody = await firstResponse.text()
    const secondBody = await secondResponse.text()
    expect(firstBody).toContain('"id":"first_original"')
    expect(firstBody).toContain('"query":"first"')
    expect(secondBody).toContain('"id":"second_original"')
    expect(secondBody).toContain('"query":"second"')
    const repairSchemas = bodies
      .filter((body) =>
        JSON.stringify(body.messages).includes("UNTRUSTED_EXISTING_ARGUMENTS"),
      )
      .map((body) => body.tools?.[0].function.parameters)
    expect(repairSchemas).toContainEqual(firstSchema)
    expect(repairSchemas).toContainEqual(secondSchema)
  }, 5_000)
})
