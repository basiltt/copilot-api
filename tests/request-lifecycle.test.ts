import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import { state } from "~/lib/state"
import { completionRoutes } from "~/routes/chat-completions/route"
import { embeddingRoutes } from "~/routes/embeddings/route"
import { responsesRoutes } from "~/routes/responses/route"

const app = new Hono()
  .route("/chat", completionRoutes)
  .route("/responses", responsesRoutes)
  .route("/embeddings", embeddingRoutes)
const originalState = { ...state }
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let errorSpy: ReturnType<typeof spyOn<typeof console, "error">>

function barrier() {
  let resolve!: () => void
  const promise = new Promise<undefined>((done) => {
    resolve = () => done(undefined)
  })
  return { promise, resolve }
}

beforeEach(() => {
  Object.assign(state, {
    copilotToken: "fixture",
    vsCodeVersion: "1",
    accountType: "individual",
    manualApprove: false,
    models: undefined,
    rateLimitSeconds: undefined,
    burstCount: undefined,
    burstWindowSeconds: undefined,
    webSearchProvider: "off",
  })
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  fetchSpy.mockRestore()
  errorSpy.mockRestore()
  for (const key of Object.keys(state)) {
    if (!Object.hasOwn(originalState, key)) Reflect.deleteProperty(state, key)
  }
  Object.assign(state, originalState)
})

function input(path: string, stream: boolean) {
  return path === "/chat" ?
      {
        model: "claude-fable-5.1",
        stream,
        messages: [{ role: "user", content: "Hello" }],
      }
    : {
        model: path === "/embeddings" ? "text-embedding-3-small" : "gpt-5.5",
        stream,
        input: "Hello",
      }
}

describe("OpenAI request transport cancellation", () => {
  test.each(["/chat", "/responses", "/embeddings"])(
    "JSON %s cancels its pending upstream byte reader",
    async (path) => {
      const started = barrier()
      const canceled = barrier()
      let upstream: AbortSignal | undefined
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          (_url: string | URL | Request, init?: RequestInit) => {
            upstream = init?.signal ?? undefined
            started.resolve()
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("{"))
                  },
                  cancel() {
                    canceled.resolve()
                  },
                }),
              ),
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      fetchSpy.mockClear()
      const controller = new AbortController()
      const pending = app.request(path, {
        method: "POST",
        body: JSON.stringify(input(path, false)),
        headers: { "content-type": "application/json" },
        signal: controller.signal,
      })
      await started.promise
      controller.abort()
      expect((await pending).status).toBe(499)
      await canceled.promise
      expect(upstream?.aborted).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    },
  )

  test.each(["/chat", "/responses"])(
    "SSE %s closes deferred upstream without logging a disconnect error",
    async (path) => {
      const canceled = barrier()
      let upstream: AbortSignal | undefined
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          (_url: string | URL | Request, init?: RequestInit) => {
            upstream = init?.signal ?? undefined
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    const event =
                      path === "/chat" ?
                        { choices: [{ delta: { content: "Hello" } }] }
                      : { type: "response.output_text.delta", delta: "Hello" }
                    controller.enqueue(
                      new TextEncoder().encode(
                        `data: ${JSON.stringify(event)}\n\n`,
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
      fetchSpy.mockClear()
      const response = await app.request(path, {
        method: "POST",
        body: JSON.stringify(input(path, true)),
        headers: { "content-type": "application/json" },
      })
      if (!response.body) throw new Error("Missing SSE body")
      const reader = response.body.getReader()
      await reader.read()
      await reader.cancel()
      await canceled.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(upstream?.aborted).toBe(true)
      expect(errorSpy).not.toHaveBeenCalled()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    },
  )
})

describe("admission options fail before server startup", () => {
  test.each(
    [
      ["--rate-limit", "NaN"],
      ["--rate-limit", "Infinity"],
      ["--rate-limit=-1"],
      ["--burst-count", "0", "--burst-window", "1"],
      ["--burst-count", "-1", "--burst-window", "1"],
      ["--burst-count", "1", "--burst-window", "Infinity"],
      ["--burst-count", "1", "--burst-window", "0"],
      ["--min-spacing", "NaN"],
      ["--min-spacing=-1"],
    ].map((args) => ({ args })),
  )(
    "rejects invalid configuration %j",
    async ({ args }) => {
      const child = Bun.spawn(
        [process.execPath, "src/main.ts", "start", ...args],
        { stdout: "ignore", stderr: "pipe", timeout: 10000 },
      )
      const text = await new Response(child.stderr).text()
      expect(await child.exited).toBe(1)
      expect(text).toContain("must be")
    },
    15000,
  )
})
