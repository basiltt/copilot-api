import type { Context } from "hono"

import { describe, test, expect, mock } from "bun:test"

import {
  HTTPError,
  buildAnthropicContextWindowErrorResponse,
  buildOpenAIContextWindowErrorBody,
  buildResponsesContextWindowFailedEvent,
  contextWindowErrorMessage,
  CONTEXT_LENGTH_EXCEEDED_CODE,
  forwardError,
  isContextWindowError,
  formatAnthropicContextWindowError,
  sendAnthropicInvalidRequestError,
} from "~/lib/error"

function makeContext(jsonFn = mock(), headerFn = mock()) {
  return { json: jsonFn, header: headerFn } as unknown as Context
}

function makeHTTPError(body: string, status: number): HTTPError {
  const response = new Response(body, { status })
  return new HTTPError("Failed", response)
}

describe("forwardError — HTTPError with JSON body", () => {
  test("converts context-window Copilot error to Anthropic format with token numbers", async () => {
    const jsonFn = mock()
    const headerFn = mock()
    const c = makeContext(jsonFn, headerFn)
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
    expect(headerFn).toHaveBeenCalledWith("request-id", typed.request_id)
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

  test("summarizes HTML upstream error pages instead of returning raw markup", async () => {
    const jsonFn = mock()
    const c = makeContext(jsonFn)
    const err = makeHTTPError(
      "<!DOCTYPE html><html><head><title>Unicorn! &middot; GitHub</title></head><body><p><strong>We had issues producing the response to your request.</strong></p></body></html>",
      502,
    )
    await forwardError(c, err)
    const [body, status] = jsonFn.mock.calls[0] as [unknown, number]
    expect(status).toBe(502)
    expect((body as { error: { message: string } }).error.message).toBe(
      "Upstream returned an HTML error page: Unicorn! · GitHub - We had issues producing the response to your request.",
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

describe("buildAnthropicContextWindowErrorResponse", () => {
  test("uses the same request id in the header payload and body", () => {
    const result = buildAnthropicContextWindowErrorResponse(
      "prompt token count of 622303 exceeds the limit of 168000",
    )
    expect(result.requestId).toMatch(/^req_/)
    expect(result.body.request_id).toBe(result.requestId)
    expect(result.body.error.message).toBe(
      "prompt is too long: 622303 tokens > 168000 maximum",
    )
  })
})

describe("sendAnthropicInvalidRequestError", () => {
  test("returns Anthropic-shaped invalid_request_error with request-id header", () => {
    const jsonFn = mock()
    const headerFn = mock()
    const c = makeContext(jsonFn, headerFn)

    sendAnthropicInvalidRequestError(c, "Embedded image is too small.")

    const [body, status] = jsonFn.mock.calls[0] as [unknown, number]
    const typed = body as {
      type: string
      request_id: string
      error: { type: string; message: string }
    }
    expect(status).toBe(400)
    expect(typed.type).toBe("error")
    expect(typed.request_id).toMatch(/^req_/)
    expect(typed.error.type).toBe("invalid_request_error")
    expect(typed.error.message).toBe("Embedded image is too small.")
    expect(headerFn).toHaveBeenCalledWith("request-id", typed.request_id)
  })
})

describe("Responses API (Codex) context-window signaling", () => {
  // Codex's SSE detector matches strictly on this code; do not change it
  // without re-verifying against codex-rs/codex-api/src/sse/responses.rs.
  test("exposes the exact code Codex pattern-matches", () => {
    expect(CONTEXT_LENGTH_EXCEEDED_CODE).toBe("context_length_exceeded")
  })

  test("buildResponsesContextWindowFailedEvent has the shape Codex parses", () => {
    const event = buildResponsesContextWindowFailedEvent(
      "prompt token count of 1402500 exceeds the limit of 935000",
    )
    expect(event.type).toBe("response.failed")
    const response = event.response as {
      status: string
      error: { code: string; message: string }
    }
    expect(response.status).toBe("failed")
    // The decisive field: Codex reads response.error.code.
    expect(response.error.code).toBe("context_length_exceeded")
    // A real, informative upstream message is preserved (no fabrication).
    expect(response.error.message).toContain("exceeds the limit of 935000")
  })

  test("does NOT fabricate token counts when upstream message is generic", () => {
    const event = buildResponsesContextWindowFailedEvent(
      "failed to parse request",
    )
    const response = event.response as { error: { message: string } }
    // The misleading "1402500 tokens > 935000" fabrication must be gone.
    expect(response.error.message).not.toMatch(/\d+ tokens > \d+/)
    expect(response.error.message).not.toContain("1402500")
  })

  test("contextWindowErrorMessage keeps genuine token-count messages", () => {
    expect(
      contextWindowErrorMessage(
        "prompt token count of 55059 exceeds the limit of 12288",
      ),
    ).toBe("prompt token count of 55059 exceeds the limit of 12288")
  })

  test("contextWindowErrorMessage falls back for unhelpful upstream text", () => {
    expect(contextWindowErrorMessage("failed to parse request")).not.toContain(
      "failed to parse request",
    )
    expect(contextWindowErrorMessage(undefined)).toMatch(/context window/i)
  })

  test("buildOpenAIContextWindowErrorBody is OpenAI-shaped with the code", () => {
    const body = buildOpenAIContextWindowErrorBody("input exceeds model limit")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.code).toBe("context_length_exceeded")
    expect(body.error.param).toBeNull()
    expect(body.error.message).toBe("input exceeds model limit")
  })
})
