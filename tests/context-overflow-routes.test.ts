import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"

import type { State } from "~/lib/state"

import { knownModelMetadata } from "~/lib/known-models"
import { state } from "~/lib/state"
import { server } from "~/server"

const message = "prompt is too long: 1886265 tokens > 1000000 maximum"
const upstreamError = { message, code: "invalid_request_body" }
let originalState: State
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let logs: Array<ReturnType<typeof spyOn<typeof consola, "debug">>>

beforeEach(() => {
  originalState = { ...state }
  const model = knownModelMetadata("claude-fable-5.1")
  if (!model) throw new Error("Missing test model")
  model.supported_endpoints = ["/chat/completions"]
  model.capabilities.supports.streaming = true
  Object.assign(state, {
    copilotToken: "test-token",
    vsCodeVersion: "1.0",
    accountType: "individual",
    models: { object: "list", data: [model] },
    nativeMessages: false,
    writeToolRecovery: false,
    toolSearchRecovery: false,
    structuredOutputRecovery: false,
    manualApprove: false,
    webSearchProvider: "off",
    rateLimitSeconds: undefined,
    burstCount: undefined,
    burstMinSpacingMs: 0,
  })
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected extra upstream request"),
  )
  fetchSpy.mockClear()
  logs = (["debug", "warn", "error", "info"] as const).map((method) =>
    spyOn(consola, method).mockImplementation(
      Object.assign(() => undefined, { raw: () => undefined }),
    ),
  )
})

afterEach(() => {
  fetchSpy.mockRestore()
  for (const log of logs) log.mockRestore()
  for (const key of Object.keys(state)) {
    if (!Object.hasOwn(originalState, key)) Reflect.deleteProperty(state, key)
  }
  Object.assign(state, originalState)
})

function send(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return server.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
}

function messagesPayload(stream: boolean, model = "claude-fable-5.1") {
  return {
    model,
    max_tokens: 128,
    stream,
    messages: [{ role: "user", content: "Synthetic context error fixture." }],
  }
}

function sse(...frames: Array<Record<string, unknown>>) {
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
      + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("deterministic overflow route contracts", () => {
  for (const status of [400, 413]) {
    for (const stream of [false, true]) {
      test(`Messages HTTP ${status}, stream=${stream}: one attempt and exact counts`, async () => {
        fetchSpy.mockResolvedValueOnce(
          Response.json(
            { error: upstreamError },
            { status, headers: { "retry-after": "0" } },
          ),
        )
        const response = await send("/v1/messages", messagesPayload(stream))
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          type: "error",
          error: { type: "invalid_request_error", message },
        })
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      })

      for (const model of ["gpt-5.5", "claude-fable-5.1"]) {
        test(`Responses ${model}, HTTP ${status}, stream=${stream}: compaction signal`, async () => {
          fetchSpy.mockResolvedValueOnce(
            Response.json(
              { error: upstreamError },
              { status, headers: { "retry-after": "0" } },
            ),
          )
          const response = await send("/v1/responses", {
            model,
            stream,
            input: "Synthetic context error fixture.",
          })
          expect(response.status).toBe(stream ? 200 : 400)
          const text = await response.text()
          expect(text).toContain('"code":"context_length_exceeded"')
          expect(text).toContain(message)
          if (stream) {
            expect(response.headers.get("content-type")).toContain(
              "text/event-stream",
            )
            expect(text.match(/event: response.failed/g)).toHaveLength(1)
            expect(text).not.toContain("response.completed")
          }
          expect(fetchSpy).toHaveBeenCalledTimes(1)
        })
      }
    }
  }

  for (const preamble of [false, true]) {
    test(`Messages in-band overflow, preamble=${preamble}: no choices access or retry`, async () => {
      const frames: Array<Record<string, unknown>> = []
      if (preamble)
        frames.push({
          id: "chat_test",
          model: "gemini-test",
          choices: [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ],
        })
      frames.push({ error: upstreamError })
      fetchSpy.mockResolvedValueOnce(sse(...frames))
      const response = await send(
        "/v1/messages",
        messagesPayload(true, "gemini-test"),
      )
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"type":"invalid_request_error"')
      expect(text).toContain(message)
      expect(text.match(/event: error/g)).toHaveLength(1)
      expect(text).not.toContain("message_stop")
      expect(text).not.toContain("tool_use")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  }

  for (const cached of [false, true]) {
    test(`opaque body compaction uses only known limits, cached=${cached}`, async () => {
      const modelId = "gemini-3.1-pro-preview"
      const model = state.models?.data[0]
      if (!model) throw new Error("Missing test model")
      model.id = modelId
      model.capabilities.limits = { max_prompt_tokens: 1_000_000 }
      if (!cached) state.models = { object: "list", data: [] }
      fetchSpy.mockResolvedValueOnce(
        Response.json(
          { error: { message: "failed to parse request" } },
          { status: 413 },
        ),
      )
      const response = await send(
        "/v1/messages",
        messagesPayload(true, modelId),
      )
      expect(response.status).toBe(400)
      const text = await response.text()
      expect(text).toContain("prompt is too long")
      expect(text).not.toContain("935000")
      expect(text).not.toContain("tokens >")
      if (cached) expect(text).toContain("1000000")
      else expect(text).not.toContain("Model context limit")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  }

  test("buffered tool streaming preserves an upstream overflow, not an api_error", async () => {
    state.toolSearchRecovery = true
    fetchSpy.mockResolvedValueOnce(sse({ error: upstreamError }))
    const response = await send("/v1/messages", {
      ...messagesPayload(true),
      tools: [
        {
          name: "ToolSearch",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      ],
    })
    const text = await response.text()
    expect(text).toContain('"type":"invalid_request_error"')
    expect(text).toContain(message)
    expect(text).not.toContain("message_stop")
    expect(text).not.toContain('"type":"tool_use"')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  for (const stream of [false, true]) {
    test(`native Messages overflow, stream=${stream}: exact counts survive`, async () => {
      state.nativeMessages = true
      const model = state.models?.data[0]
      if (!model) throw new Error("Missing test model")
      model.supported_endpoints = ["/v1/messages", "/chat/completions"]
      const body = {
        type: "error",
        error: { type: "invalid_request_error", ...upstreamError },
      }
      fetchSpy.mockResolvedValueOnce(
        stream ? sse(body) : Response.json(body, { status: 400 }),
      )
      const response = await send("/v1/messages", messagesPayload(stream))
      const text = await response.text()
      expect(text).toContain('"type":"invalid_request_error"')
      expect(text).toContain(message)
      expect(text).not.toContain("message_stop")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url] = fetchSpy.mock.calls[0]
      expect(url instanceof Request ? url.url : url.toString()).toContain(
        "/v1/messages",
      )
    })
  }

  test("Responses Chat stream normalizes invalid_request_body when it proves overflow", async () => {
    fetchSpy.mockResolvedValueOnce(sse({ error: upstreamError }))
    const response = await send("/v1/responses", {
      model: "claude-fable-5.1",
      stream: true,
      input: "Synthetic context error fixture.",
    })
    const text = await response.text()
    expect(text).toContain('"code":"context_length_exceeded"')
    expect(text).toContain(message)
    expect(text.match(/event: response.failed/g)).toHaveLength(1)
    expect(text).not.toContain("response.completed")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe("body-size, context metadata, and cancellation boundaries", () => {
  for (const model of ["gpt-5.5", "claude-fable-5.1"]) {
    test(`Responses ${model}: a context code preserves differently worded genuine counts`, async () => {
      const counts = "Input tokens: 1886265. Allowed input tokens: 1000000."
      fetchSpy.mockResolvedValueOnce(
        Response.json(
          { error: { message: counts, code: "context_length_exceeded" } },
          { status: 400 },
        ),
      )
      const response = await send("/v1/responses", {
        model,
        stream: false,
        input: "Synthetic context error fixture.",
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { message: counts, code: "context_length_exceeded" },
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    test(`Responses ${model}: a body-size 413 is not evidence of token overflow`, async () => {
      fetchSpy.mockResolvedValueOnce(
        Response.json(
          { error: { message: "Request Entity Too Large", code: "body_size" } },
          { status: 413 },
        ),
      )
      const response = await send("/v1/responses", {
        model,
        stream: true,
        input: "hello",
      })
      expect(response.status).toBe(413)
      expect(await response.text()).not.toContain("context_length_exceeded")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  }

  test("a policy rejection retains precedence over context-like message text", async () => {
    const policy = { error: { message, code: "cyber_policy" } }
    fetchSpy.mockResolvedValueOnce(Response.json(policy, { status: 422 }))
    const response = await send("/v1/responses", {
      model: "gpt-5.5",
      stream: true,
      input: "hello",
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(policy)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("canceling a transient retry stops before another upstream attempt", async () => {
    const controller = new AbortController()
    fetchSpy.mockImplementationOnce(
      Object.assign(
        () => {
          controller.abort()
          return Promise.resolve(
            Response.json(
              { error: { message: "temporary backend failure" } },
              { status: 502, headers: { "retry-after": "60" } },
            ),
          )
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    const response = await send(
      "/v1/messages",
      messagesPayload(false),
      controller.signal,
    )
    expect(response.status).toBe(499)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  for (const { native, status } of [
    { native: false, status: 502 },
    { native: false, status: 413 },
    { native: true, status: 413 },
  ]) {
    test(`canceling during HTTP ${status} body inspection, native=${native}: no retry or reader leak`, async () => {
      state.nativeMessages = native
      const model = state.models?.data[0]
      if (!model) throw new Error("Missing test model")
      if (native)
        model.supported_endpoints = ["/v1/messages", "/chat/completions"]
      const controller = new AbortController()
      let cancelled = false
      fetchSpy.mockImplementationOnce(
        Object.assign(
          () => {
            const body = new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(new TextEncoder().encode('{"error":'))
              },
              cancel() {
                cancelled = true
              },
            })
            setTimeout(() => controller.abort(), 0)
            return Promise.resolve(new Response(body, { status }))
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const response = await send(
        "/v1/messages",
        messagesPayload(false),
        controller.signal,
      )
      expect(response.status).toBe(499)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(cancelled).toBe(true)
    }, 1000)
  }
})
