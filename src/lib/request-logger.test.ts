import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import "~/lib/context-vars"

import {
  extractBodyFields,
  formatDuration,
  requestLogger,
} from "./request-logger"

function makeApp(
  handler: (c: import("hono").Context) => Response | Promise<Response>,
) {
  const app = new Hono()
  app.use(requestLogger)
  app.post("/test", handler)
  return app
}

describe("formatDuration", () => {
  test("formats sub-second durations as Xms", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(42)).toBe("42ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  test("formats >= 1000ms as X.Xs", () => {
    expect(formatDuration(1000)).toBe("1.0s")
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(45200)).toBe("45.2s")
  })
})

// Helper: create a Hono Context from a raw Request so we can unit-test
// extractBodyFields without spinning up a full server.
async function makeContext(req: Request): Promise<import("hono").Context> {
  let capturedCtx!: import("hono").Context
  const app = new Hono()
  app.all("/*", (c) => {
    capturedCtx = c
    return c.text("ok")
  })
  await app.request(req)
  return capturedCtx
}

describe("extractBodyFields", () => {
  test("extracts model and stream from valid JSON body", async () => {
    const body = JSON.stringify({ model: "gpt-5.4", stream: true })
    const ctx = await makeContext(
      new Request("http://x", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      }),
    )
    const result = await extractBodyFields(ctx)
    expect(result.model).toBe("gpt-5.4")
    expect(result.stream).toBe(true)
  })

  test("returns empty object for non-JSON body", async () => {
    const ctx = await makeContext(
      new Request("http://x", { method: "POST", body: "not json" }),
    )
    const result = await extractBodyFields(ctx)
    expect(result.model).toBeUndefined()
    expect(result.stream).toBeUndefined()
  })

  test("returns empty object for empty body", async () => {
    const ctx = await makeContext(new Request("http://x", { method: "GET" }))
    const result = await extractBodyFields(ctx)
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

  test("passes through non-2xx responses unchanged", async () => {
    // Verifies the middleware does not break error responses —
    // status and body are forwarded to the client as-is.
    const app = makeApp((c) =>
      c.json({ error: { message: "model not found" } }, 404),
    )
    const res = await app.request("/test", {
      method: "POST",
      body: JSON.stringify({ model: "bad-model" }),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe("model not found")
  })

  test("reads tokenCount set by handler via context", async () => {
    // Verifies the c.set("tokenCount", n) / c.get("tokenCount") round-trip works
    // across the middleware boundary, which is the mechanism the logger uses to
    // display token counts in the log line.
    let readBack: number | undefined
    const app = new Hono()
    // Observer middleware wraps requestLogger: runs before and after it
    app.use(async (c, next) => {
      await next() // runs requestLogger + handler
      readBack = c.get("tokenCount")
    })
    app.use(requestLogger)
    app.post("/verify", (c) => {
      c.set("tokenCount", 999)
      return c.json({ ok: true })
    })
    const res = await app.request("/verify", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4" }),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(200)
    expect(readBack).toBe(999)
  })
})
