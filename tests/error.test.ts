import type { Context } from "hono"

import { describe, test, expect, mock } from "bun:test"

import { HTTPError, forwardError } from "~/lib/error"

function makeContext(jsonFn = mock()) {
  return { json: jsonFn } as unknown as Context
}

function makeHTTPError(body: string, status: number): HTTPError {
  const response = new Response(body, { status })
  return new HTTPError("Failed", response)
}

describe("forwardError — HTTPError with JSON body", () => {
  test("forwards Copilot JSON error object directly", async () => {
    const jsonFn = mock()
    const c = makeContext(jsonFn)
    const err = makeHTTPError(
      JSON.stringify({
        error: {
          message: "prompt token count of 55059 exceeds the limit of 12288",
          code: "model_max_prompt_tokens_exceeded",
        },
      }),
      400,
    )
    await forwardError(c, err)
    expect(jsonFn).toHaveBeenCalledTimes(1)
    const [body, status] = jsonFn.mock.calls[0] as [unknown, number]
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe(
      "model_max_prompt_tokens_exceeded",
    )
  })

  test("wraps plain-text error in envelope", async () => {
    const jsonFn = mock()
    const c = makeContext(jsonFn)
    const err = makeHTTPError("Bad Gateway", 502)
    await forwardError(c, err)
    const [body, status] = jsonFn.mock.calls[0] as [unknown, number]
    expect(status).toBe(502)
    expect(
      (body as { error: { message: string; type: string } }).error.type,
    ).toBe("error")
    expect((body as { error: { message: string } }).error.message).toBe(
      "Bad Gateway",
    )
  })

  test("preserves status code from upstream", async () => {
    const jsonFn = mock()
    const c = makeContext(jsonFn)
    const err = makeHTTPError(
      JSON.stringify({ error: { message: "not found" } }),
      404,
    )
    await forwardError(c, err)
    const [, status] = jsonFn.mock.calls[0] as [unknown, number]
    expect(status).toBe(404)
  })
})

describe("forwardError — non-HTTPError", () => {
  test("returns 500 with error message", async () => {
    const jsonFn = mock()
    const c = makeContext(jsonFn)
    await forwardError(c, new Error("something broke"))
    const [body, status] = jsonFn.mock.calls[0] as [unknown, number]
    expect(status).toBe(500)
    expect((body as { error: { message: string } }).error.message).toBe(
      "something broke",
    )
  })
})
