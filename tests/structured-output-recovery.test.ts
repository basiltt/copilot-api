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
import { OUTPUT_LIMIT_VISIBLE_TEXT } from "~/routes/messages/output-limit"
import { messageRoutes } from "~/routes/messages/route"
import { STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS } from "~/routes/messages/structured-output-recovery"
import {
  parseToolInput,
  ToolSchemaMismatchError,
} from "~/routes/messages/tool-input"
import {
  createToolNameMapFromAnthropicPayload,
  toOpenAIToolName,
} from "~/routes/messages/tool-name-mapping"
import { configureStructuredOutputRecovery } from "~/start"

import { chatCompletionSSE } from "./helpers/chat-completion-sse"

const app = new Hono().route("/v1/messages", messageRoutes)
const originalState = { ...state }
const originalEnv = process.env.STRUCTURED_OUTPUT_RECOVERY
const originalSetTimeout = globalThis.setTimeout
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let timerSpy:
  | ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>
  | undefined
let logs: Array<ReturnType<typeof spyOn<typeof consola, "debug">>> = []
let bodies: Array<ChatCompletionsPayload> = []
let replies: Array<(stream: boolean) => Response> = []
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
}

function payload(stream = false): AnthropicMessagesPayload {
  return {
    model: "claude-fable-5.1",
    messages: [{ role: "user", content: "Report the answer as ready." }],
    max_tokens: 256,
    stream,
    tools: [{ name: "StructuredOutput", input_schema: schema }],
    tool_choice: { type: "auto" },
  }
}

function completion(
  raw = '{"answer":"ready"}',
  id = "original_call",
): ChatCompletionResponse {
  return {
    id: "chat_original",
    object: "chat.completion",
    created: 1,
    model: "claude-fable-5.1",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        logprobs: null,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: "StructuredOutput", arguments: raw },
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

function queue(...responses: Array<ChatCompletionResponse | Response>) {
  replies = responses.map((response) => {
    if (response instanceof Response) return () => response
    return (stream) =>
      stream ? chatCompletionSSE(response) : Response.json(response)
  })
}

function send(body = payload(), signal?: AbortSignal) {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
}

function events(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

beforeEach(() => {
  bodies = []
  replies = []
  state.structuredOutputRecovery = true
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0"
  state.webSearchProvider = "off"
  state.rateLimitSeconds = undefined
  state.burstCount = undefined
  state.burstMinSpacingMs = 0
  const model = knownModelMetadata("claude-fable-5.1")
  if (!model) throw new Error("Expected model")
  model.supported_endpoints = ["/chat/completions"]
  model.capabilities.supports.streaming = true
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
        const body = JSON.parse(init.body) as ChatCompletionsPayload
        bodies.push(body)
        const next = replies.shift()
        if (!next) throw new Error("Unexpected extra upstream request")
        return Promise.resolve(next(body.stream === true))
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
  if (originalEnv === undefined) delete process.env.STRUCTURED_OUTPUT_RECOVERY
  else process.env.STRUCTURED_OUTPUT_RECOVERY = originalEnv
})

function setRecoverySetting(value: string) {
  process.env.STRUCTURED_OUTPUT_RECOVERY = value
}

// eslint-disable-next-line max-lines-per-function -- Related request/response fixtures share one bounded recovery suite.
describe("bounded output-format recovery through Messages", () => {
  test.each([false, true])(
    "schema mismatch becomes valid once (stream=%s), preserving IDs and usage",
    async (stream) => {
      const request = payload(stream)
      request.tools?.push({
        name: "Workflow",
        input_schema: { type: "object" },
      })
      queue(
        completion('{"answer":42}'),
        completion('{"answer":"ready"}', "new_call"),
      )
      const response = await send(request)
      expect(response.status).toBe(200)
      const raw = await response.text()
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(raw).toContain("original_call")
      expect(raw).not.toContain("new_call")
      expect(raw).toContain("answer")
      expect(raw).not.toContain('"answer":42')
      expect(bodies[1].model).toBe("claude-fable-5.1")
      expect(bodies[1].tool_choice).toBe("auto")
      expect(bodies[1].tools?.map((tool) => tool.function.name)).toEqual([
        "StructuredOutput",
      ])
      expect(bodies[1].tools?.[0].function.parameters).toEqual(schema)
      expect(JSON.stringify(bodies[1].messages)).toContain(
        "Report the answer as ready.",
      )
      expect(bodies.every((body) => body.stream === stream)).toBe(true)
      if (stream) {
        const output = events(raw)
        expect(
          output.filter((event) => event.type === "message_start"),
        ).toHaveLength(1)
        expect(
          output.filter((event) => event.type === "message_stop"),
        ).toHaveLength(1)
        expect(
          output.find((event) => event.type === "message_start"),
        ).toMatchObject({
          message: { usage: { input_tokens: 34, cache_read_input_tokens: 6 } },
        })
        expect(
          output.find((event) => event.type === "message_delta"),
        ).toMatchObject({ usage: { output_tokens: 10 } })
      } else {
        expect(JSON.parse(raw)).toMatchObject({
          id: "msg_chat_original",
          stop_reason: "tool_use",
          usage: {
            input_tokens: 34,
            output_tokens: 10,
            cache_read_input_tokens: 6,
          },
        })
      }
    },
  )

  test.each([false, true])(
    "valid output has no extra request (stream=%s)",
    async (stream) => {
      queue(completion())
      const response = await send(payload(stream))
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("original_call")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    },
  )

  test("original streamed late-system request keeps exact Chat order and uses one upstream SSE call", async () => {
    const request = payload(true)
    const model = state.models?.data[0]
    if (!model) throw new Error("Expected model")
    model.id = "claude-sonnet-5"
    model.name = "claude-sonnet-5"
    model.capabilities.family = "claude-sonnet-5"
    model.capabilities.limits.max_output_tokens = 64_000
    request.model = "claude-sonnet-5"
    request.max_tokens = 64_000
    request.messages = [
      { role: "user", content: "first" },
      { role: "system", content: "later instruction" },
      { role: "user", content: "last" },
    ]
    const queued = completion()
    queued.model = "claude-sonnet-5"
    queue(queued)

    const response = await send(request)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("original_call")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const target = fetchSpy.mock.calls[0][0]
    const url = target instanceof Request ? target.url : target.toString()
    expect(url).toEndWith("/chat/completions")
    expect(bodies[0]).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 64_000,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "user", content: "first" },
        { role: "system", content: "later instruction" },
        { role: "user", content: "last" },
      ],
    })
  })

  test.each([
    { capability: "missing", vendor: "Anthropic" },
    { capability: "false", vendor: "Anthropic" },
    { capability: "true", vendor: "Other" },
    { capability: "true", vendor: undefined },
  ])(
    "keeps buffered JSON when streaming=$capability and vendor=$vendor",
    async ({ capability, vendor }) => {
      const model = state.models?.data[0]
      if (!model) throw new Error("Expected model")
      if (vendor === undefined) Reflect.deleteProperty(model, "vendor")
      else model.vendor = vendor
      if (capability === "missing") delete model.capabilities.supports.streaming
      else model.capabilities.supports.streaming = capability === "true"
      queue(completion())

      const response = await send(payload(true))

      expect(response.status).toBe(200)
      expect(await response.text()).toContain("original_call")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(bodies[0].stream).toBe(false)
      expect(bodies[0].stream_options).toBeUndefined()
    },
  )

  test("partial catalog metadata stays safe and preserves the explicit streaming gate", async () => {
    const model = state.models?.data[0]
    if (!model) throw new Error("Expected model")
    Reflect.deleteProperty(model, "capabilities")
    const truncated = completion('{"answer":"partial"}')
    truncated.choices[0].finish_reason = "length"
    queue(truncated)

    const response = await send(payload(true))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"stop_reason":"max_tokens"')
    expect(bodies[0].stream).toBe(false)
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    expect(captured).toContain('"catalogMaxContextTokens":null')
  })

  test("missing catalog limits stays safe without disabling an explicit streaming capability", async () => {
    const model = state.models?.data[0]
    if (!model) throw new Error("Expected model")
    Reflect.deleteProperty(model.capabilities, "limits")
    const truncated = completion('{"answer":"partial"}')
    truncated.choices[0].finish_reason = "length"
    queue(truncated)

    const response = await send(payload(true))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"stop_reason":"max_tokens"')
    expect(bodies[0].stream).toBe(true)
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    expect(captured).toContain('"catalogMaxContextTokens":null')
  })

  test("nonstream client stays upstream nonstream with streaming capability", async () => {
    queue(completion())

    const response = await send(payload(false))

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(bodies[0].stream).toBe(false)
    expect(bodies[0].stream_options).toBeUndefined()
  })

  test("buffered streamed truncation reports actual one-shot wire and usage metadata", async () => {
    const truncated = completion('{"answer":"partial"}')
    truncated.choices[0].finish_reason = "length"
    queue(truncated)

    const response = await send(payload(true))
    const output = await response.text()

    expect(response.status).toBe(200)
    expect(output).toContain('"stop_reason":"max_tokens"')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    expect(captured).toContain('"clientStream":true')
    expect(captured).toContain(
      '"finalRequest":{"endpoint":"chat_completions","tokenField":"max_tokens","tokenValue":256,"stream":true,"oneShot":true,"nativeRouting":"native_disabled"}',
    )
    expect(captured).toContain('"catalogMaxContextTokens":1000000')
    expect(captured).toContain('"promptTokens":20')
    expect(captured).toContain('"cachedPromptTokens":3')
    expect(captured).toContain('"completionTokens":5')
  })

  test("streamed truncation with prose and missing identity keeps omission notice and count", async () => {
    const truncated = completion('{"answer":"partial"')
    truncated.choices[0].finish_reason = "length"
    truncated.choices[0].message.content = "Partial explanation."
    const call = truncated.choices[0].message.tool_calls?.[0]
    if (!call) throw new Error("Expected tool")
    Reflect.deleteProperty(call, "id")
    queue(chatCompletionSSE(truncated))

    const response = await send(payload(true))
    const output = await response.text()

    expect(response.status).toBe(200)
    expect(output).toContain("Partial explanation.")
    expect(output).toContain(OUTPUT_LIMIT_VISIBLE_TEXT)
    expect(output).toContain("Do not execute unfinished tool input")
    expect(output).toContain("smaller complete tool operations")
    expect(output).not.toContain('"type":"tool_use"')
    expect(output).not.toContain("original_call")
    expect(output).not.toContain('{"answer"')
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    expect(captured).toContain('"toolCallCount":1')
  })

  test("streamed truncation with prose and partial declared name keeps omission notice", async () => {
    const truncated = completion('{"answer":"partial"')
    truncated.choices[0].finish_reason = "length"
    truncated.choices[0].message.content = "Partial explanation."
    const call = truncated.choices[0].message.tool_calls?.[0]
    if (!call) throw new Error("Expected tool")
    call.function.name = "StructuredOut"
    queue(chatCompletionSSE(truncated))

    const response = await send(payload(true))
    const output = await response.text()

    expect(response.status).toBe(200)
    expect(output).toContain("Partial explanation.")
    expect(output).toContain(OUTPUT_LIMIT_VISIBLE_TEXT)
    expect(output).not.toContain('"type":"tool_use"')
    expect(output).not.toContain("StructuredOut")
    expect(output).not.toContain('{"answer"')
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    expect(captured).toContain('"toolCallCount":1')
  })

  test("recovery is disabled by default, with explicit startup parsing", async () => {
    delete process.env.STRUCTURED_OUTPUT_RECOVERY
    configureStructuredOutputRecovery()
    expect(state.structuredOutputRecovery).toBe(false)
    queue(completion('{"answer":42}'))
    expect((await send()).status).toBe(502)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    for (const setting of ["1", "true"]) {
      setRecoverySetting(setting)
      configureStructuredOutputRecovery()
      expect(state.structuredOutputRecovery).toBe(true)
    }
    setRecoverySetting("maybe")
    expect(configureStructuredOutputRecovery).toThrow("must be")
  })

  test.each(["executable", "mixed", "text", "malformed", "multiple choices"])(
    "does not regenerate %s output",
    async (kind) => {
      const request = payload()
      const result = completion('{"answer":42}')
      const choice = result.choices[0]
      const call = choice.message.tool_calls?.[0]
      if (!call) throw new Error("Expected tool")
      if (kind === "executable") {
        request.tools = [{ name: "Workflow", input_schema: schema }]
        call.function.name = "Workflow"
      }
      if (kind === "mixed") {
        choice.message.tool_calls?.push({
          ...call,
          id: "other_call",
          function: { name: "Workflow", arguments: "{}" },
        })
      }
      if (kind === "text") choice.message.content = "Some prose"
      if (kind === "malformed") call.function.arguments = '{"answer":'
      if (kind === "multiple choices")
        result.choices.push({ ...choice, index: 1 })
      queue(result)
      expect((await send(request)).status).toBe(502)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    },
  )

  test("initial length-truncated output bypasses recovery and reports max_tokens", async () => {
    const result = completion('{"answer":42}')
    result.choices[0].finish_reason = "length"
    queue(result)

    const response = await send()
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"stop_reason":"max_tokens"')
    expect(body).toContain('"type":"tool_use"')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test.each([
    "wrong name",
    "multiple tools",
    "schema",
    "malformed",
    "length",
    "different model",
  ])("rejects repaired %s without a third request", async (kind) => {
    const repaired = completion()
    const call = repaired.choices[0].message.tool_calls?.[0]
    if (!call) throw new Error("Expected tool")
    if (kind === "wrong name") call.function.name = "Workflow"
    if (kind === "multiple tools")
      repaired.choices[0].message.tool_calls?.push({ ...call, id: "extra" })
    if (kind === "schema") call.function.arguments = '{"answer":42}'
    if (kind === "malformed") call.function.arguments = "{"
    if (kind === "length") repaired.choices[0].finish_reason = "length"
    if (kind === "different model") repaired.model = "another-model"
    queue(completion('{"answer":42}'), repaired)
    const response = await send()
    expect(response.status).toBe(502)
    expect(await response.text()).toContain("type at $/*")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test.each([false, true])(
    "invalid repair emits an error, not partial success (stream=%s)",
    async (stream) => {
      queue(completion('{"answer":42}'), completion('{"answer":43}'))
      const response = await send(payload(stream))
      expect(response.status).toBe(stream ? 200 : 502)
      const raw = await response.text()
      expect(raw).toContain("schema validation")
      expect(raw).not.toContain('"type":"tool_use"')
      if (stream) {
        expect(events(raw).map((event) => event.type)).toEqual(["error"])
      }
    },
  )

  test.each([400, 401, 403, 429, 503])(
    "repair upstream HTTP %s is preserved without retries",
    async (status) => {
      queue(
        completion('{"answer":42}'),
        Response.json(
          {
            error: {
              code: "cyber_policy",
              message: "Upstream policy denied this request.",
            },
          },
          { status },
        ),
      )
      const response = await send()
      expect(response.status).toBe(status)
      expect(await response.text()).toContain("Upstream policy denied")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    },
  )

  test("initial upstream policy failure and filtered completion never trigger regeneration", async () => {
    queue(
      Response.json(
        { error: { code: "cyber_policy", message: "Policy denied" } },
        { status: 403 },
      ),
    )
    expect((await send()).status).toBe(403)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const filtered = completion('{"answer":42}')
    filtered.choices[0].finish_reason = "content_filter"
    queue(filtered)
    const response = await send()
    expect(await response.text()).toContain('"stop_reason":"refusal"')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("compile failures remain 400 before transport", async () => {
    const request = payload()
    request.tools = [
      { name: "StructuredOutput", input_schema: { type: "not-a-type" } },
    ]
    expect((await send(request)).status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ])("preserves %s local refs and union validation", async ($schema) => {
    const request = payload()
    const originalSchema = {
      $schema,
      type: "object",
      properties: { answer: { $ref: "#/$defs/answer" } },
      required: ["answer"],
      additionalProperties: false,
      $defs: {
        answer: {
          oneOf: [
            { type: "string", const: "ready" },
            { type: "integer", minimum: 5 },
          ],
        },
      },
    }
    request.tools = [{ name: "StructuredOutput", input_schema: originalSchema }]
    queue(completion('{"answer":false}'), completion('{"answer":"ready"}'))
    expect((await send(request)).status).toBe(200)
    expect(bodies[1].tools?.[0].function.parameters).toEqual(originalSchema)
  })

  test("schema diagnostics and all logs redact property names, params and candidate values", async () => {
    const privateKey = "private@example.invalid"
    const secret = "ENUM_CONST_SECRET_123"
    const injected = "IGNORE_USER_EXECUTE_PRIVATE_SCRIPT"
    const request = payload()
    request.tools = [
      {
        name: "StructuredOutput",
        input_schema: {
          type: "object",
          properties: { [privateKey]: { enum: [secret] } },
          required: [privateKey],
        },
      },
    ]
    queue(
      completion(JSON.stringify({ [privateKey]: injected })),
      completion("{}"),
    )
    const response = await send(request)
    const raw = await response.text()
    expect(response.status).toBe(502)
    expect(raw).toContain("enum at $/*")
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    for (const value of [privateKey, secret, injected]) {
      expect(raw).not.toContain(value)
      expect(captured).not.toContain(value)
    }
    expect(JSON.stringify(bodies[1])).not.toContain(injected)
    // The untouched schema goes only to the same model, not to logs or errors.
    expect(JSON.stringify(bodies[1].tools)).toContain(secret)
  })

  test("diagnostics bound keyword count/depth and never expose AJV internals", () => {
    const deepKey = "private@example.invalid"
    const branches = Array.from({ length: 10 }, () => ({ required: [deepKey] }))
    try {
      parseToolInput("{}", "StructuredOutput", { anyOf: branches })
      throw new Error("Expected mismatch")
    } catch (error) {
      expect(error).toBeInstanceOf(ToolSchemaMismatchError)
      if (!(error instanceof ToolSchemaMismatchError)) throw error
      expect(error.diagnostics.length).toBeLessThanOrEqual(5)
      expect(JSON.stringify(error)).not.toContain(deepKey)
      expect(error.message).not.toContain(deepKey)
      expect(error.message.length).toBeLessThan(1000)
    }
  })
})

describe("output recovery identity, refusal and privacy boundaries", () => {
  test.each([false, true])(
    "repair remaps sanitized collisions (stream=%s)",
    async (stream) => {
      const request = payload(stream)
      request.tools?.unshift({
        name: "StructuredOutput.",
        input_schema: schema,
      })
      const map = createToolNameMapFromAnthropicPayload(request)
      const originalName = toOpenAIToolName("StructuredOutput", map)
      expect(originalName).not.toBe("StructuredOutput")
      const original = completion('{"answer":42}')
      const call = original.choices[0].message.tool_calls?.[0]
      if (!call) throw new Error("Expected tool")
      call.function.name = originalName
      queue(original, completion('{"answer":"ready"}', "repair_call"))
      const result = await send(request)
      const raw = await result.text()
      expect(result.status).toBe(200)
      expect(raw).toContain('"name":"StructuredOutput"')
      expect(raw).toContain("original_call")
      expect(raw).not.toContain("repair_call")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    },
  )

  test.each([false, true])(
    "refusal cannot commit valid tool arguments (stream=%s)",
    async (stream) => {
      const original = completion()
      original.choices[0].message.refusal = "Declined"
      queue(original)
      const result = await send(payload(stream))
      const raw = await result.text()
      expect(result.status).toBe(200)
      expect(raw).toContain('"stop_reason":"refusal"')
      expect(raw).not.toContain('"type":"tool_use"')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    },
  )

  test.each(["enum", "const", "required", "additionalProperties"])(
    "redacts %s values and properties in SSE diagnostics",
    async (keyword) => {
      const privateKey = "private@example.invalid"
      const secret = "PRIVATE_CONST_987"
      const inputSchema: Record<string, unknown> = {
        type: "object",
        properties: {
          [privateKey]: { [keyword]: keyword === "enum" ? [secret] : secret },
        },
      }
      let invalid = JSON.stringify({ [privateKey]: "invalid" })
      if (keyword === "required") {
        inputSchema.properties = {}
        inputSchema.required = [privateKey]
        invalid = "{}"
      }
      if (keyword === "additionalProperties") {
        inputSchema.properties = {}
        inputSchema.additionalProperties = false
      }
      const request = payload(true)
      request.tools = [{ name: "StructuredOutput", input_schema: inputSchema }]
      queue(completion(invalid), completion(invalid))
      const raw = await (await send(request)).text()
      expect(raw).toContain(keyword)
      expect(raw).not.toContain('"type":"tool_use"')
      const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
      for (const value of [privateKey, secret]) {
        expect(raw).not.toContain(value)
        expect(captured).not.toContain(value)
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    },
  )
})

function captureDeadline() {
  let expire: (() => void) | undefined
  let registrations = 0
  timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: Array<unknown>) => void,
    delay?: number,
    ...args: Array<unknown>
  ) => {
    if (
      delay === STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS
      && typeof callback === "function"
    ) {
      registrations++
      expire = () => callback()
    }
    return originalSetTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  return () => {
    expect(STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS).toBe(20_000)
    expect(registrations).toBe(1)
    if (!expire) throw new Error("Recovery deadline not installed")
    expire()
  }
}

describe("hard recovery deadline and disconnect cancellation", () => {
  test.each(["headers", "body"])(
    "20s deadline aborts the actual request during %s",
    async (stage) => {
      const expire = captureDeadline()
      let repairSignal: AbortSignal | undefined
      let bodyCanceled = false
      let started: (() => void) | undefined
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      let calls = 0
      fetchSpy.mockImplementation(
        Object.assign(
          (_url: string | URL | Request, init?: RequestInit) => {
            calls++
            if (calls === 1) {
              if (typeof init?.body !== "string")
                throw new Error("Expected JSON request body")
              const body = JSON.parse(init.body) as ChatCompletionsPayload
              const initial = completion('{"answer":42}')
              return Promise.resolve(
                body.stream ?
                  chatCompletionSSE(initial)
                : Response.json(initial),
              )
            }
            repairSignal = init?.signal ?? undefined
            if (!repairSignal) throw new Error("Missing request abort signal")
            started?.()
            if (stage === "headers") {
              return new Promise<Response>((_resolve, reject) => {
                repairSignal?.addEventListener(
                  "abort",
                  () => reject(new Error("Transport aborted by caller")),
                  { once: true },
                )
              })
            }
            return Promise.resolve(
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"id":'))
                  },
                  cancel() {
                    bodyCanceled = true
                  },
                }),
                { headers: { "content-type": "application/json" } },
              ),
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const responsePromise = send()
      await ready
      await Promise.resolve()
      expire()
      const response = await responsePromise
      expect(response.status).toBe(502)
      const text = await response.text()
      expect(text).toContain("type at $/*")
      expect(text).toContain("timed out after 20 seconds")
      expect(repairSignal?.aborted).toBe(true)
      expect(calls).toBe(2)
      if (stage === "body") expect(bodyCanceled).toBe(true)
    },
  )

  test.each([false, true])(
    "downstream cancellation aborts body reading (stream=%s)",
    async (stream) => {
      let started: (() => void) | undefined
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      let repairSignal: AbortSignal | undefined
      let canceled = false
      let calls = 0
      fetchSpy.mockImplementation(
        Object.assign(
          (_url: string | URL | Request, init?: RequestInit) => {
            calls++
            if (calls === 1) {
              if (typeof init?.body !== "string")
                throw new Error("Expected JSON request body")
              const body = JSON.parse(init.body) as ChatCompletionsPayload
              const initial = completion('{"answer":42}')
              return Promise.resolve(
                body.stream ?
                  chatCompletionSSE(initial)
                : Response.json(initial),
              )
            }
            repairSignal = init?.signal ?? undefined
            return Promise.resolve(
              new Response(
                new ReadableStream({
                  pull() {
                    started?.()
                  },
                  cancel() {
                    canceled = true
                  },
                }),
              ),
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const controller = new AbortController()
      const pending = send(payload(stream), controller.signal)
      await ready
      if (stream) {
        const response = await pending
        await response.body?.cancel()
      } else {
        controller.abort(new Error("Client disconnected"))
        await pending
      }
      await Promise.resolve()
      await Promise.resolve()
      expect(repairSignal?.aborted).toBe(true)
      expect(canceled).toBe(true)
      expect(calls).toBe(2)
    },
  )
})

function useResponses() {
  const model = state.models?.data[0]
  if (!model) throw new Error("Expected cached model")
  model.supported_endpoints = ["/responses"]
}

function response(raw: string, id = "original_call") {
  return {
    id: "resp_original",
    model: "claude-fable-5.1",
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: id,
        name: "StructuredOutput",
        arguments: raw,
      },
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
      input_tokens_details: { cached_tokens: 3 },
    },
  }
}

describe("Responses-only models retain the same recovery boundaries", () => {
  test("missing completion status cannot trigger recovery or commit a tool", async () => {
    useResponses()
    queue(
      Response.json({ ...response('{"answer":"ready"}'), status: undefined }),
    )
    const result = await send()
    expect(result.status).toBe(502)
    expect(await result.text()).toContain("explicit completion status")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test.each([false, true])(
    "recovers schema-only invalid Responses output (stream=%s)",
    async (stream) => {
      useResponses()
      queue(
        Response.json(response('{"answer":42}')),
        Response.json(response('{"answer":"ready"}', "other_id")),
      )
      const result = await send(payload(stream))
      const raw = await result.text()
      expect(result.status).toBe(200)
      expect(raw).toContain("original_call")
      expect(raw).not.toContain("other_id")
      expect(raw).toContain('"cache_read_input_tokens":6')
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(fetchSpy.mock.calls[0][0]).toContain("/responses")
      expect(bodies[1].tool_choice).toBe("auto")
      expect(bodies[1].tools).toMatchObject([
        { type: "function", name: "StructuredOutput", parameters: schema },
      ])
    },
  )

  test.each(["failed", "incomplete"])(
    "preserves structured response.%s policy details",
    async (status) => {
      useResponses()
      queue(
        Response.json({
          ...response('{"answer":42}'),
          status,
          error: {
            code: "cyber_policy",
            message: "Upstream policy denied this output",
          },
        }),
      )
      const result = await send()
      expect(result.status).toBe(502)
      const raw = await result.text()
      expect(raw).toContain("Upstream policy denied")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    },
  )

  test.each(["refusal", "server action"])(
    "never recovers Responses output containing %s",
    async (kind) => {
      useResponses()
      const extra =
        kind === "refusal" ?
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "Declined" }],
          }
        : { type: "web_search_call", id: "server_action" }
      const original = response('{"answer":42}')
      queue(Response.json({ ...original, output: [...original.output, extra] }))
      const result = await send()
      expect(result.status).toBe(kind === "refusal" ? 200 : 502)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(await result.text()).not.toContain('"type":"tool_use"')
    },
  )
})
