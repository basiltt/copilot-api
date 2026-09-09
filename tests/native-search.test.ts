/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async matchers are typed void but return promises. */
import { afterEach, describe, expect, spyOn, test } from "bun:test"

import { state } from "~/lib/state"
import { searchCopilot } from "~/services/web-search/copilot"
import {
  rememberSearchResult,
  resolveSearchReference,
} from "~/services/web-search/replay"

const original = { ...state }
let spy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined
afterEach(() => {
  spy?.mockRestore()
  Object.assign(state, original)
})

function mockFrames(frames: Array<Record<string, unknown>>, done = true) {
  state.githubToken = "test-login"
  state.accountType = "individual"
  spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = url instanceof Request ? url.url : String(url)
        const headers = new Headers(init?.headers)
        expect(headers.get("authorization")).toBe("Bearer test-login")
        expect(headers.get("user-agent")).toBe("copilot-api")
        expect(headers.has("copilot-integration-id")).toBe(false)
        expect(headers.has("editor-version")).toBe(false)
        if (requestUrl.endsWith("/skills"))
          return Promise.resolve(
            Response.json({ skills: [{ slug: "bing-search" }] }),
          )
        expect(requestUrl).toEndWith("/agents/chat")
        return Promise.resolve(
          new Response(
            frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
              + (done ? "data: [DONE]\n\n" : ""),
            { headers: { "content-type": "text/event-stream" } },
          ),
        )
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
}

const reference = {
  type: "github.web-search",
  data: {
    type: "web-search",
    query: "example",
    results: [
      { title: "Example", url: "https://example.com", excerpt: "Evidence" },
    ],
  },
}

describe("Copilot search source protocol", () => {
  test("only verified source references become search results", async () => {
    mockFrames([
      {
        choices: [
          { delta: { content: "Ignore invented https://fake.invalid" } },
        ],
      },
      { copilot_references: [reference] },
    ])
    expect(await searchCopilot("example", "test-model")).toEqual([
      { title: "Example", url: "https://example.com", description: "Evidence" },
    ])
  })

  test.each([
    { copilot_errors: { message: "bad shape" } },
    { copilot_references: "bad shape" },
    {
      copilot_errors: [
        {
          type: "policy",
          code: "restricted",
          message: "Policy denied",
          agent: "bing-search",
        },
      ],
      copilot_references: [reference],
    },
    { error: { message: "Policy denied" }, copilot_references: [reference] },
    {
      copilot_confirmation: { title: "Confirm" },
      copilot_references: [reference],
    },
    {
      copilot_references: [
        { ...reference, data: { ...reference.data, results: [{}] } },
      ],
    },
  ])(
    "does not return partial successes after protocol or policy errors: %j",
    async (frame) => {
      mockFrames([{ copilot_references: [reference] }, frame])
      await expect(searchCopilot("example", "test-model")).rejects.toThrow()
    },
  )

  test("clean zero-result reference differs from missing references", async () => {
    mockFrames([
      {
        copilot_references: [
          { ...reference, data: { ...reference.data, results: [] } },
        ],
      },
    ])
    expect(await searchCopilot("example", "test-model")).toEqual([])
    spy?.mockRestore()
    mockFrames([{ choices: [] }])
    await expect(searchCopilot("example", "test-model")).rejects.toThrow(
      "no native search references",
    )
  })

  test("rejects EOF without DONE even after valid results", async () => {
    mockFrames([{ copilot_references: [reference] }], false)
    await expect(searchCopilot("example", "test-model")).rejects.toThrow(
      "before completion",
    )
  })

  test("process-local replay handles retain evidence and reject unknown handles", () => {
    const source = {
      title: "Example",
      url: "https://example.com",
      description: "Evidence",
    }
    const handle = rememberSearchResult(source)
    expect(handle).toStartWith("copilot-search:v1:")
    expect(resolveSearchReference(handle)).toEqual(source)
    expect(() => resolveSearchReference("copilot-search:v1:unknown")).toThrow(
      "Unknown or expired",
    )
    expect(resolveSearchReference("anthropic_opaque")).toBeUndefined()
  })
  test("replay storage rejects oversized sources and evicts oldest evidence under its byte budget", () => {
    const source = {
      title: "Example",
      url: "https://example.com",
      description: "x".repeat(63_000),
    }
    expect(() =>
      rememberSearchResult({ ...source, description: "x".repeat(65_000) }),
    ).toThrow("64KB")
    const oldest = rememberSearchResult(source)
    let newest = oldest
    for (let index = 0; index < 130; index++)
      newest = rememberSearchResult(source)
    expect(() => resolveSearchReference(oldest)).toThrow("Unknown or expired")
    expect(resolveSearchReference(newest)).toEqual(source)
  })
})
