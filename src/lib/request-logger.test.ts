import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { requestLogger } from "./request-logger"

function makeApp(
  handler: (c: import("hono").Context) => Response | Promise<Response>,
) {
  const app = new Hono()
  app.use(requestLogger)
  app.post("/test", handler)
  return app
}

describe("formatDuration", () => {
  // Import the helper directly for unit testing
  test("formats sub-second durations as Xms", async () => {
    const { formatDuration } = await import("./request-logger")
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(42)).toBe("42ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  test("formats >= 1000ms as X.Xs", async () => {
    const { formatDuration } = await import("./request-logger")
    expect(formatDuration(1000)).toBe("1.0s")
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(45200)).toBe("45.2s")
  })
})

describe("extractBodyFields", () => {
  test("extracts model and stream from valid JSON body", async () => {
    const { extractBodyFields } = await import("./request-logger")
    const body = JSON.stringify({ model: "gpt-5.4", stream: true })
    const result = await extractBodyFields(
      new Request("http://x", { method: "POST", body }),
    )
    expect(result.model).toBe("gpt-5.4")
    expect(result.stream).toBe(true)
  })

  test("returns empty object for non-JSON body", async () => {
    const { extractBodyFields } = await import("./request-logger")
    const result = await extractBodyFields(
      new Request("http://x", { method: "POST", body: "not json" }),
    )
    expect(result.model).toBeUndefined()
    expect(result.stream).toBeUndefined()
  })

  test("returns empty object for empty body", async () => {
    const { extractBodyFields } = await import("./request-logger")
    const result = await extractBodyFields(
      new Request("http://x", { method: "GET" }),
    )
    expect(result.model).toBeUndefined()
  })
})

describe("requestLogger middleware", () => {
  test("calls next() and passes through the response", async () => {
    const app = makeApp((c) => c.json({ ok: true }, 200))
    const res = await app.request("/test", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4" }),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  test("does not interfere with handler reading req.json()", async () => {
    let parsed: unknown
    const app = makeApp(async (c) => {
      parsed = await c.req.json()
      return c.json({ ok: true })
    })
    await app.request("/test", {
      method: "POST",
      body: JSON.stringify({ model: "test-model", stream: false }),
      headers: { "content-type": "application/json" },
    })
    expect((parsed as { model: string }).model).toBe("test-model")
  })
})
