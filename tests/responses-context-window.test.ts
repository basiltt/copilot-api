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

/** A real context-window rejection with token-limit language. */
function upstreamContext413(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "prompt token count of 940000 exceeds the limit of 922000",
      },
    }),
    {
      status: 413,
      headers: { "content-type": "application/json" },
    },
  )
}

/** Copilot's opaque parser/body-size rejection. */
function upstreamOpaque413(): Response {
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
    fetchMock.mockResolvedValue(upstreamContext413())

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
    expect(text).toContain("940000 exceeds the limit of 922000")
    // The old fabricated token figures must not appear.
    expect(text).not.toContain("1402500")
  })

  test("non-streaming: returns OpenAI-shaped 400 with the context_length_exceeded code", async () => {
    fetchMock.mockResolvedValue(upstreamContext413())

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

  test("opaque Copilot 413 parser failures are not misclassified as context-window", async () => {
    fetchMock.mockResolvedValue(upstreamOpaque413())

    const res = await postResponses({
      model: "gpt-5.5",
      stream: true,
      input: [{ role: "user", content: "hello" }],
    })

    expect(res.status).toBe(413)
    const text = await res.text()
    expect(text).toContain("failed to parse request")
    expect(text).not.toContain("context_length_exceeded")
  })

  test("function_call_output images enable Copilot vision headers", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ id: "resp_1", object: "response", output: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    await postResponses({
      model: "gpt-5.5",
      stream: false,
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "Screenshot:" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
            },
          ],
        },
      ],
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(init.headers["copilot-vision-request"]).toBe("true")
  })

  test("opaque Copilot 413 with images retries once with image placeholders", async () => {
    fetchMock
      .mockResolvedValueOnce(upstreamOpaque413())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "resp_1", object: "response", output: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )

    const res = await postResponses({
      model: "gpt-5.5",
      stream: false,
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "Screenshot:" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
            },
          ],
        },
      ],
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstCall = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ]
    const retryCall = fetchMock.mock.calls[1] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ]
    expect(firstCall[1].headers["copilot-vision-request"]).toBe("true")
    expect(firstCall[1].body).toContain('"type":"input_image"')
    expect(retryCall[1].body).not.toContain('"type":"input_image"')
    expect(retryCall[1].body).not.toContain("data:image/png")
    expect(retryCall[1].body).toContain(
      "Image removed by proxy after Copilot rejected the request body",
    )
  })

  test("after one image parser rejection, later requests in the same window strip before upstream", async () => {
    const input = [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "Screenshot:" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,BBBB",
          },
        ],
      },
    ]
    const metadata = {
      session_id: "session-image-cache-test",
      "x-codex-window-id": "session-image-cache-test:0",
    }

    fetchMock
      .mockResolvedValueOnce(upstreamOpaque413())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "resp_1", object: "response", output: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )

    await postResponses({
      model: "gpt-5.5",
      stream: false,
      metadata,
      input,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: "resp_2", object: "response", output: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const res = await postResponses({
      model: "gpt-5.5",
      stream: false,
      metadata,
      input,
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ]
    expect(init.body).not.toContain('"type":"input_image"')
    expect(init.body).not.toContain("data:image/png")
    expect(init.headers["copilot-vision-request"]).toBeUndefined()
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
