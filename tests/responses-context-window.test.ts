import { describe, test, expect, mock, beforeEach } from "bun:test"

import { state } from "~/lib/state"
import { responsesRoutes } from "~/routes/responses/route"

// Minimal state so handleResponses reaches the upstream fetch.
// `gpt-5.5` routes to the native /responses path via its `gpt-5` prefix, so no
// model catalog is needed (resolveModelId returns the id unchanged).
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.models = undefined
state.manualApprove = false
state.rateLimitSeconds = undefined
state.rateLimitWait = false

const fetchMock = mock((): Promise<unknown> => Promise.resolve())

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  fetchMock.mockReset()
})

/** A Copilot 413 with the opaque body that previously broke compaction. */
function upstream413(): Response {
  return new Response(
    JSON.stringify({ error: { message: "failed to parse request" } }),
    {
      status: 413,
      headers: { "content-type": "application/json" },
    },
  )
}

async function postResponses(body: unknown): Promise<Response> {
  return responsesRoutes.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("Responses route — context-window 413 → Codex compaction signal", () => {
  test("streaming: returns 200 SSE with a response.failed / context_length_exceeded event", async () => {
    fetchMock.mockResolvedValue(upstream413())

    const res = await postResponses({
      model: "gpt-5.5",
      stream: true,
      input: [{ role: "user", content: "hello" }],
    })

    // MUST be 200 — Codex's transport discards the body of any non-2xx
    // response before its SSE parser runs, so a 4xx can never compact.
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const text = await res.text()
    expect(text).toContain("event: response.failed")
    expect(text).toContain('"code":"context_length_exceeded"')
    // The old fabricated token figures must not appear.
    expect(text).not.toContain("1402500")
  })

  test("non-streaming: returns OpenAI-shaped 400 with the context_length_exceeded code", async () => {
    fetchMock.mockResolvedValue(upstream413())

    const res = await postResponses({
      model: "gpt-5.5",
      stream: false,
      input: [{ role: "user", content: "hello" }],
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; type: string }
    }
    expect(body.error.code).toBe("context_length_exceeded")
    expect(body.error.type).toBe("invalid_request_error")
  })

  test("unrelated upstream errors are NOT misclassified as context-window", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "internal server error" } }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      ),
    )

    const res = await postResponses({
      model: "gpt-5.5",
      stream: true,
      input: [{ role: "user", content: "hello" }],
    })

    // Falls through to normal error forwarding (500), no compaction signal.
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain("context_length_exceeded")
    // The original upstream body must survive detection (clone, not consume),
    // so forwardError can still read and forward it.
    expect(text).toContain("internal server error")
  })
})
