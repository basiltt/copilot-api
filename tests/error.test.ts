import type { Context } from "hono"

import { describe, test, expect, mock } from "bun:test"

import {
  HTTPError,
  forwardError,
  isContextWindowError,
  formatAnthropicContextWindowError,
} from "~/lib/error"

function makeContext(jsonFn = mock()) {
  return { json: jsonFn } as unknown as Context
}

function makeHTTPError(body: string, status: number): HTTPError {
  const response = new Response(body, { status })
  return new HTTPError("Failed", response)
}

describe("forwardError — HTTPError with JSON body", () => {
  test("converts context-window Copilot error to Anthropic format with token numbers", async () => {
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
    const typed = body as {
      type: string
      request_id: string
      error: { type: string; message: string }
    }
    expect(typed.type).toBe("error")
    expect(typed.request_id).toMatch(/^req_/)
    expect(typed.error.type).toBe("invalid_request_error")
    expect(typed.error.message).toBe(
      "prompt is too long: 55059 tokens > 12288 maximum",
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

describe("isContextWindowError", () => {
  test("detects Copilot 'exceeds the limit' format", () => {
    expect(
      isContextWindowError(
        "prompt token count of 622303 exceeds the limit of 168000",
      ),
    ).toBe(true)
  })

  test("detects model_max_prompt_tokens_exceeded code", () => {
    expect(
      isContextWindowError(
        '{"error":{"message":"prompt too big","code":"model_max_prompt_tokens_exceeded"}}',
      ),
    ).toBe(true)
  })

  test("detects 'exceeds the context window'", () => {
    expect(
      isContextWindowError("This request exceeds the context window"),
    ).toBe(true)
  })

  test("detects context_length_exceeded", () => {
    expect(isContextWindowError("context_length_exceeded")).toBe(true)
  })

  test("detects 'maximum context length'", () => {
    expect(
      isContextWindowError(
        "This model's maximum context length is 128000 tokens",
      ),
    ).toBe(true)
  })

  test("detects 'input exceeds'", () => {
    expect(isContextWindowError("input exceeds model limit")).toBe(true)
  })

  test("returns false for unrelated errors", () => {
    expect(isContextWindowError("rate limit exceeded")).toBe(false)
    expect(isContextWindowError("internal server error")).toBe(false)
    expect(isContextWindowError("model not found")).toBe(false)
  })
})

describe("formatAnthropicContextWindowError", () => {
  test("extracts token numbers from Copilot error format", () => {
    expect(
      formatAnthropicContextWindowError(
        "prompt token count of 622303 exceeds the limit of 168000",
      ),
    ).toBe("prompt is too long: 622303 tokens > 168000 maximum")
  })

  test("handles comma-separated numbers", () => {
    expect(
      formatAnthropicContextWindowError(
        "prompt token count of 622,303 exceeds the limit of 168,000",
      ),
    ).toBe("prompt is too long: 622303 tokens > 168000 maximum")
  })

  test("falls back to defaults when no numbers found", () => {
    const result = formatAnthropicContextWindowError("context_length_exceeded")
    expect(result).toMatch(/^prompt is too long: \d+ tokens > \d+ maximum$/)
  })

  test("falls back to defaults for empty string", () => {
    const result = formatAnthropicContextWindowError("")
    expect(result).toMatch(/^prompt is too long: \d+ tokens > \d+ maximum$/)
  })
})
