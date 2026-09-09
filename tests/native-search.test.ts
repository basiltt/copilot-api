/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async matchers are typed void but return promises. */
import { afterEach, describe, expect, spyOn, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { searchCopilot } from "~/services/web-search/copilot"
import {
  rememberSearchResult,
  resolveSearchReference,
} from "~/services/web-search/replay"

import {
  createNativeMcpFixture,
  nativeSearchResult,
  nativeSearchTool,
} from "./fixtures/native-mcp"

const original = { ...state }
let spy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined
afterEach(() => {
  spy?.mockRestore()
  Object.assign(state, original)
})

function mockMcp(options: Parameters<typeof createNativeMcpFixture>[0] = {}) {
  state.githubToken = "test-login"
  const fixture = createNativeMcpFixture(options)
  spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: string | URL | Request, init?: RequestInit) => {
        const response = fixture.handle(url, init)
        if (!response) throw new Error("Unexpected provider or endpoint")
        return Promise.resolve(response)
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  return fixture
}

describe("native MCP error boundaries", () => {
  test("preserves JSON-RPC policy details as an upstream error", async () => {
    mockMcp({
      rpcError: {
        code: -32001,
        message: "Policy denied",
        data: { reason: "policy_denied" },
      },
    })
    try {
      await searchCopilot("example")
      throw new Error("Expected upstream policy error")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      if (!(error instanceof HTTPError)) throw error
      expect(error.response.status).toBe(502)
      expect(await error.response.json()).toMatchObject({
        error: { code: -32001, details: { reason: "policy_denied" } },
      })
    }
  })

  test("stops unbounded discovery and oversized response bodies", async () => {
    let fixture = mockMcp({ pages: [{ tools: [], nextCursor: "repeated" }] })
    await expect(searchCopilot("example")).rejects.toThrow("repeated")
    expect(
      fixture.calls.filter((call) => call.method === "tools/list"),
    ).toHaveLength(2)
    spy?.mockRestore()
    fixture = mockMcp({
      result: { content: [{ type: "text", text: "x".repeat(2_000_001) }] },
    })
    await expect(searchCopilot("example")).rejects.toThrow(
      "response size limit",
    )
    expect(
      fixture.calls.filter((call) => call.method === "tools/call"),
    ).toHaveLength(1)
  })

  test("missing ordinary authentication cannot trigger discovery or another provider", async () => {
    const fixture = mockMcp()
    state.githubToken = undefined
    state.braveApiKey = "not-used"
    await expect(searchCopilot("example")).rejects.toThrow(
      "configured GitHub login",
    )
    expect(fixture.calls).toHaveLength(0)
  })
})

describe("Copilot native MCP search", () => {
  test.each([false, true])(
    "negotiates MCP and separates AI synthesis from cited source links (SSE=%s)",
    async (sse) => {
      const fixture = mockMcp({ sse })
      const output = await searchCopilot("example")
      expect(output.results).toEqual([
        {
          title: "Example reference",
          url: "https://example.com/docs",
          description: "",
        },
      ])
      expect(output.summary).toContain("Copilot-generated")
      expect(
        output.results.some(
          (source) =>
            source.url.includes("bing.com")
            || source.url.includes("not-a-source"),
        ),
      ).toBe(false)
      expect(fixture.calls.map((call) => call.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ])
      expect(fixture.calls.at(-1)?.params).toEqual({
        name: "web_search",
        arguments: { query: "example" },
      })
      expect(
        fixture.headers.every(
          (headers) => headers.get("authorization") === "Bearer test-login",
        ),
      ).toBe(true)
      expect(
        fixture.headers.every(
          (headers) =>
            !headers.has("copilot-integration-id")
            && !headers.has("editor-version"),
        ),
      ).toBe(true)
      expect(
        fixture.headers.some(
          (headers) => headers.get("mcp-protocol-version") === "2025-06-18",
        ),
      ).toBe(true)
      expect(
        fixture.headers.some(
          (headers) => headers.get("mcp-session-id") === "fixture-session",
        ),
      ).toBe(true)
    },
  )

  test("follows advertised pagination and never calls a missing or incompatible tool", async () => {
    let fixture = mockMcp({
      pages: [{ tools: [], nextCursor: "next" }, { tools: [nativeSearchTool] }],
    })
    expect((await searchCopilot("example")).results).toHaveLength(1)
    expect(
      fixture.calls.filter((call) => call.method === "tools/list")[1].params,
    ).toEqual({ cursor: "next" })
    spy?.mockRestore()
    fixture = mockMcp({ pages: [{ tools: [] }] })
    await expect(searchCopilot("example")).rejects.toThrow("does not advertise")
    expect(fixture.calls.some((call) => call.method === "tools/call")).toBe(
      false,
    )
    spy?.mockRestore()
    fixture = mockMcp({
      pages: [
        {
          tools: [
            { ...nativeSearchTool, annotations: { readOnlyHint: false } },
          ],
        },
      ],
    })
    await expect(searchCopilot("example")).rejects.toThrow("unsupported")
    expect(fixture.calls.some((call) => call.method === "tools/call")).toBe(
      false,
    )
  })

  test.each([
    { result: { content: [] } },
    { result: { content: [{ type: "text", text: "not JSON" }] } },
    {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              type: "output_text",
              text: { value: "no annotation schema" },
            }),
          },
        ],
      },
    },
    {
      result: nativeSearchResult([
        { url_citation: { title: "Bad", url: "javascript:alert(1)" } },
      ]),
    },
    {
      rpcError: {
        code: -32001,
        message: "Account policy denied search.",
        data: { reason: "policy_denied" },
      },
    },
    {
      result: {
        isError: true,
        content: [{ type: "text", text: "Account policy denied search." }],
      },
    },
    { callStatus: 403 },
  ])(
    "fails visibly on protocol/policy errors without fallback: %j",
    async (options) => {
      mockMcp(options)
      await expect(searchCopilot("example")).rejects.toThrow()
    },
  )

  test("a valid zero-citation answer is not invented source evidence", async () => {
    mockMcp({ result: nativeSearchResult([]) })
    const output = await searchCopilot("example")
    expect(output.results).toEqual([])
    expect(output.summary).toBeString()
  })

  test("process-local replay handles retain evidence and reject unknown handles", () => {
    const source = {
      title: "Example",
      url: "https://example.com",
      description: "",
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
