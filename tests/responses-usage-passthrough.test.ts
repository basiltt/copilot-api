import { describe, test, expect, mock, beforeEach } from "bun:test"

import { state } from "~/lib/state"
import { responsesRoutes } from "~/routes/responses/route"

// Minimal state so handleResponses reaches the upstream fetch.
// `gpt-5.5` routes to the native /responses path via its `gpt-5` prefix.
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

/** A minimal successful non-streaming /responses body. */
function upstreamOk(): Response {
  return new Response(
    JSON.stringify({ id: "resp_1", object: "response", output: [] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

/** Parses the JSON body the handler forwarded to the upstream fetch. */
function forwardedBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
  return JSON.parse(call[1].body) as Record<string, unknown>
}

async function postResponses(body: unknown): Promise<Response> {
  return responsesRoutes.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("Responses route — verbatim passthrough (Codex owns compaction)", () => {
  test("a large item is forwarded byte-for-byte (no per-item trim)", async () => {
    fetchMock.mockResolvedValue(upstreamOk())

    // ~300KB single item: far above the old 40KB per-item cap. It MUST be
    // forwarded untouched so Copilot's reported token usage reflects the true
    // context size and Codex can decide to auto-compact on its own.
    const big = "word ".repeat(60_000) // ~300KB
    await postResponses({
      model: "gpt-5.5",
      stream: false,
      input: [{ role: "user", content: big }],
    })

    const sent = forwardedBody()
    const input = sent.input as Array<{ content: string }>
    expect(input[0].content).toBe(big)
    expect(input[0].content).not.toContain("[...truncated...]")
    expect(input[0].content).not.toContain("[removed]")
  })

  test("even a multi-megabyte body is forwarded verbatim — never trimmed", async () => {
    fetchMock.mockResolvedValue(upstreamOk())

    // Two ~3MB items → ~6MB total. The proxy must NOT mutate the body: Codex
    // owns its conversation state and compacts itself once usage crosses the
    // configured limit. Trimming here would desync Codex's token accounting
    // from what Copilot received and could silently drop conversation data.
    const huge = "x".repeat(3_000_000)
    const sentInput = [
      { role: "user", content: huge },
      { role: "user", content: huge },
    ]
    await postResponses({ model: "gpt-5.5", stream: false, input: sentInput })

    const sent = forwardedBody()
    const input = sent.input as Array<{ content: string }>
    // Both items survive intact — nothing trimmed, nothing removed.
    expect(input).toHaveLength(2)
    expect(input[0].content).toBe(huge)
    expect(input[1].content).toBe(huge)
    expect(JSON.stringify(sent).length).toBeGreaterThan(6_000_000)
  })
})
