import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { knownModelMetadata } from "~/lib/known-models"
import { state } from "~/lib/state"
import { messageRoutes } from "~/routes/messages/route"

import { createNativeMcpFixture } from "./fixtures/native-mcp"

const app = new Hono()
  .get("/health", (c) => c.json({ status: "ok" }))
  .route("/v1/messages", messageRoutes)
const originalState = { ...state }
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let logs: Array<ReturnType<typeof spyOn<typeof consola, "debug">>> = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function barrier() {
  const pending = deferred<boolean>()
  return { promise: pending.promise, resolve: () => pending.resolve(true) }
}

function payload(label: string, stream: boolean): AnthropicMessagesPayload {
  return {
    model: "claude-fable-5.1",
    max_tokens: 128,
    stream,
    messages: [{ role: "user", content: label }],
    tools: [
      {
        name: "Write",
        input_schema: {
          type: "object",
          properties: { [label]: { type: "string", const: label } },
          required: [label],
          additionalProperties: false,
        },
      },
    ],
  }
}

function send(label: string, stream: boolean, signal?: AbortSignal) {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload(label, stream)),
    signal,
  })
}

function jsonCompletion(label: string, input: string, name = "Write") {
  return Response.json({
    id: `response_${label}`,
    model: "claude-fable-5.1",
    object: "chat.completion",
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
              id: `call_${label}`,
              type: "function",
              function: { name, arguments: input },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function streamLane(label: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const canceled = barrier()
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
      cancel() {
        canceled.resolve()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  const push = (data: unknown) =>
    controller.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          id: `response_${label}`,
          model: "claude-fable-5.1",
          object: "chat.completion.chunk",
          ...(data as object),
        })}\n\n`,
      ),
    )
  return {
    response,
    canceled: canceled.promise,
    start() {
      push({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${label}`,
                  type: "function",
                  function: { name: "Write", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    },
    fragment(text: string) {
      push({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: text },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    },
    end() {
      push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
      controller.close()
    },
  }
}

beforeEach(() => {
  Object.assign(state, {
    copilotToken: "fixture",
    vsCodeVersion: "1.0",
    accountType: "individual",
    manualApprove: false,
    rateLimitSeconds: undefined,
    burstCount: undefined,
    burstWindowSeconds: undefined,
    webSearchProvider: "off",
    structuredOutputRecovery: true,
  })
  const model = knownModelMetadata("claude-fable-5.1")
  if (!model) throw new Error("Missing fixture model")
  model.supported_endpoints = ["/chat/completions"]
  state.models = { object: "list", data: [model] }
  logs = (["debug", "info", "warn", "error"] as const).map((key) =>
    spyOn(consola, key).mockImplementation(
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

describe("concurrent Messages request and tool isolation", () => {
  test.each([false, true])(
    "two JSON requests overlap and invalid A cannot affect B (invalid=%s)",
    async (invalid) => {
      const arrived = barrier()
      const first = deferred<Response>()
      const second = deferred<Response>()
      let active = 0
      let peak = 0
      const schemas: Array<unknown> = []
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (_url: string | URL | Request, init?: RequestInit) => {
            if (typeof init?.body !== "string") throw new Error("Missing body")
            const body = JSON.parse(init.body) as ChatCompletionsPayload
            schemas.push(body.tools?.[0].function.parameters)
            active++
            peak = Math.max(peak, active)
            if (active === 2) arrived.resolve()
            const result = await (
              body.messages[0].content === "A" ?
                first
              : second).promise
            active--
            return result
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      fetchSpy.mockClear()
      const a = send("A", false)
      const b = send("B", false)
      await arrived.promise
      expect(peak).toBe(2)
      expect(active).toBe(2)
      expect(schemas).toContainEqual(
        payload("A", false).tools?.[0].input_schema,
      )
      expect(schemas).toContainEqual(
        payload("B", false).tools?.[0].input_schema,
      )
      expect((await app.request("/health")).status).toBe(200)
      second.resolve(jsonCompletion("B", '{"B":"B"}'))
      const responseB = await b
      expect(await responseB.json()).toMatchObject({
        content: [
          { type: "tool_use", id: "call_B", name: "Write", input: { B: "B" } },
        ],
      })
      expect(active).toBe(1)
      first.resolve(jsonCompletion("A", invalid ? "{}" : '{"A":"A"}'))
      const responseA = await a
      expect(responseA.status).toBe(invalid ? 502 : 200)
      const text = await responseA.text()
      expect(text).not.toContain("call_B")
      if (invalid) expect(text).toContain("required at $")
      else expect(text).toContain("call_A")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    },
  )

  test.each([false, true])(
    "fragmented SSE calls stay isolated while A is slow (invalid=%s)",
    async (invalid) => {
      const arrived = barrier()
      const lanes = { A: streamLane("A"), B: streamLane("B") }
      let starts = 0
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          (_url: string | URL | Request, init?: RequestInit) => {
            if (typeof init?.body !== "string") throw new Error("Missing body")
            const body = JSON.parse(init.body) as ChatCompletionsPayload
            starts++
            if (starts === 2) arrived.resolve()
            return Promise.resolve(
              body.messages[0].content === "A" ?
                lanes.A.response
              : lanes.B.response,
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      fetchSpy.mockClear()
      const a = send("A", true)
      const b = send("B", true)
      await arrived.promise
      lanes.A.start()
      lanes.B.start()
      lanes.A.fragment("{")
      lanes.B.fragment('{"B":')
      expect((await app.request("/health")).status).toBe(200)
      lanes.B.fragment('"B"}')
      lanes.B.end()
      const textB = await (await b).text()
      expect(textB).toContain("call_B")
      expect(textB).not.toContain("call_A")
      expect(textB).toContain("message_stop")
      lanes.A.fragment(invalid ? "}" : '"A":"A"}')
      lanes.A.end()
      const textA = await (await a).text()
      expect(textA).not.toContain("call_B")
      if (invalid) {
        expect(textA).toContain("required at $")
        expect(textA).not.toContain('"type":"tool_use"')
      } else expect(textA).toContain("call_A")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    },
  )
})

describe("request-scoped cancellation through real Hono routes", () => {
  test("native MCP search shares downstream cancellation and cannot start another model pass", async () => {
    const started = barrier()
    const fixture = createNativeMcpFixture()
    let searchSignal: AbortSignal | undefined
    let modelCalls = 0
    state.githubToken = "fixture"
    state.webSearchProvider = "copilot"
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (url: string | URL | Request, init?: RequestInit) => {
          if (
            typeof init?.body === "string"
            && (url instanceof Request ? url.url : String(url)).includes(
              "/mcp/",
            )
          ) {
            const rpc = JSON.parse(init.body) as { method: string }
            if (rpc.method === "tools/call") {
              searchSignal = init.signal ?? undefined
              started.resolve()
              return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("fixture canceled")),
                  { once: true },
                )
              })
            }
          }
          const mcp = fixture.handle(url, init)
          if (mcp) return Promise.resolve(mcp)
          if (typeof init?.body !== "string")
            throw new Error("Missing completion body")
          const body = JSON.parse(init.body) as ChatCompletionsPayload
          const name = body.tools?.at(-1)?.function.name
          if (!name) throw new Error("Missing server search adapter")
          modelCalls++
          return Promise.resolve(
            jsonCompletion("search", '{"query":"example"}', name),
          )
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    fetchSpy.mockClear()
    const controller = new AbortController()
    const pending = app.request("/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload("A", false),
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 1 },
        ],
      }),
    })
    await started.promise
    controller.abort()
    expect((await pending).status).toBe(499)
    expect(searchSignal?.aborted).toBe(true)
    expect(modelCalls).toBe(1)
    expect(fixture.calls.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ])
  })
})

describe("completion cancellation through real Hono routes", () => {
  test("cancels a queued request before upstream without consuming account admission", async () => {
    const queued = barrier()
    const originalTimer = globalThis.setTimeout
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: Array<unknown>) => void,
      delay?: number,
      ...args: Array<unknown>
    ) => {
      if (delay !== undefined && delay > 30_000 && delay <= 60_000)
        queued.resolve()
      return originalTimer(callback, delay, ...args)
    }) as typeof setTimeout)
    try {
      state.rateLimitSeconds = 60
      state.rateLimitWait = true
      state.lastRequestTimestamp = Date.now()
      const timestamp = state.lastRequestTimestamp
      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        jsonCompletion("B", '{"B":"B"}'),
      )
      fetchSpy.mockClear()
      const controller = new AbortController()
      const pending = send("A", false, controller.signal)
      await queued.promise
      controller.abort()
      expect((await pending).status).toBe(499)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(state.lastRequestTimestamp).toBe(timestamp)
      state.rateLimitSeconds = undefined
      expect((await send("B", false)).status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    } finally {
      timerSpy.mockRestore()
    }
  })

  test("aborts a pending JSON body read and its real fetch signal, never B", async () => {
    const arrived = barrier()
    const canceled = barrier()
    const signals: Array<AbortSignal> = []
    const stalled = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'))
        },
        cancel() {
          canceled.resolve()
        },
      }),
    )
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (_url: string | URL | Request, init?: RequestInit) => {
          if (!init?.signal) throw new Error("Missing cancellation signal")
          signals.push(init.signal)
          if (signals.length === 2) arrived.resolve()
          return Promise.resolve(
            signals.length === 1 ? stalled : jsonCompletion("B", '{"B":"B"}'),
          )
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    fetchSpy.mockClear()
    const controller = new AbortController()
    const a = send("A", false, controller.signal)
    const b = send("B", false)
    await arrived.promise
    const textB = await (await b).text()
    expect(textB).toContain("call_B")
    controller.abort()
    expect((await a).status).toBe(499)
    await canceled.promise
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("downstream SSE cancellation aborts only A's deferred iterator, body and ping timer", async () => {
    const arrived = barrier()
    const lanes = { A: streamLane("A"), B: streamLane("B") }
    const signals: Array<AbortSignal> = []
    const activePings = new Set<number>()
    const originalInterval = globalThis.setInterval
    const originalClear = globalThis.clearInterval
    const intervals = spyOn(globalThis, "setInterval").mockImplementation(((
      callback: (...args: Array<unknown>) => void,
      delay?: number,
      ...args: Array<unknown>
    ) => {
      const timer = originalInterval(callback, delay, ...args)
      activePings.add(Number(timer))
      return timer
    }) as typeof setInterval)
    const clears = spyOn(globalThis, "clearInterval").mockImplementation(
      (timer) => {
        activePings.delete(Number(timer))
        originalClear(Number(timer))
      },
    )
    try {
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          (_url: string | URL | Request, init?: RequestInit) => {
            if (!init?.signal) throw new Error("Missing cancellation signal")
            signals.push(init.signal)
            if (signals.length === 2) arrived.resolve()
            return Promise.resolve(
              signals.length === 1 ? lanes.A.response : lanes.B.response,
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      fetchSpy.mockClear()
      const a = send("A", true)
      const b = send("B", true)
      await arrived.promise
      lanes.A.start()
      lanes.B.start()
      const responseA = await a
      const responseB = await b
      if (!responseA.body) throw new Error("Missing downstream SSE body")
      const reader = responseA.body.getReader()
      await reader.read()
      expect(activePings.size).toBe(2)
      await reader.cancel()
      expect(signals[0].aborted).toBe(true)
      expect(signals[1].aborted).toBe(false)
      expect(activePings.size).toBe(1)
      await lanes.A.canceled
      lanes.B.fragment('{"B":"B"}')
      lanes.B.end()
      const textB = await responseB.text()
      expect(textB).toContain("call_B")
      expect(textB).toContain("message_stop")
      expect(textB).not.toContain("call_A")
      expect(textB).not.toContain("error")
      expect(activePings.size).toBe(0)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    } finally {
      intervals.mockRestore()
      clears.mockRestore()
    }
  })
})
