import { describe, test, expect } from "bun:test"

import { isTypedTool, type AnthropicTool } from "~/routes/messages/anthropic-types"
import {
  WEB_SEARCH_TOOL_NAMES,
  WEB_SEARCH_FUNCTION_TOOL,
} from "~/services/web-search/tool-definition"

describe("WEB_SEARCH_TOOL_NAMES", () => {
  test("contains web_search", () => {
    expect(WEB_SEARCH_TOOL_NAMES.has("web_search")).toBe(true)
  })

  test("contains internet_research", () => {
    expect(WEB_SEARCH_TOOL_NAMES.has("internet_research")).toBe(true)
  })

  test("does NOT contain search (too generic)", () => {
    expect(WEB_SEARCH_TOOL_NAMES.has("search")).toBe(false)
  })
})

describe("Typed tool detection guard", () => {
  test("typed tool named web_search — no input_schema — matches", () => {
    const tool: AnthropicTool = { type: "web_search_20260101", name: "web_search" }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(true)
  })

  test("typed tool named internet_research matches", () => {
    const tool: AnthropicTool = { type: "internet_research_20260101", name: "internet_research" }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(true)
  })

  test("future versioned type — detected by name, not type string", () => {
    const tool: AnthropicTool = { type: "web_search_20260101", name: "web_search" }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(true)
  })

  test("custom tool named web_search WITH input_schema — NOT matched", () => {
    const tool: AnthropicTool = {
      name: "web_search",
      input_schema: { type: "object", properties: {} },
    }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(false)
  })

  test("custom tool named search WITH input_schema — NOT matched", () => {
    const tool: AnthropicTool = {
      name: "search",
      input_schema: { type: "object", properties: {} },
    }
    expect(isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name)).toBe(false)
  })
})

describe("WEB_SEARCH_FUNCTION_TOOL", () => {
  test("type is function", () => {
    expect(WEB_SEARCH_FUNCTION_TOOL.type).toBe("function")
  })

  test("function name is web_search", () => {
    expect(WEB_SEARCH_FUNCTION_TOOL.function.name).toBe("web_search")
  })

  test("has parameters with query property", () => {
    const params = WEB_SEARCH_FUNCTION_TOOL.function.parameters as {
      properties: { query: unknown }
      required: string[]
    }
    expect(params.properties.query).toBeDefined()
    expect(params.required).toContain("query")
  })
})

import { BraveSearchError } from "~/services/web-search/types"
import * as braveModule from "~/services/web-search/brave"

describe("searchBrave — result formatting", () => {
  test("formats top 5 results as BraveSearchResult[]", async () => {
    const mockResponse = {
      web: {
        results: [
          { title: "Result 1", url: "https://example.com/1", description: "Desc 1" },
          { title: "Result 2", url: "https://example.com/2", description: "Desc 2" },
          { title: "Result 3", url: "https://example.com/3", description: "Desc 3" },
          { title: "Result 4", url: "https://example.com/4", description: "Desc 4" },
          { title: "Result 5", url: "https://example.com/5", description: "Desc 5" },
        ],
      },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })) as unknown as typeof fetch

    try {
      const results = await braveModule.searchBrave("test query", "fake-api-key")
      expect(results).toHaveLength(5)
      expect(results[0]).toEqual({
        title: "Result 1",
        url: "https://example.com/1",
        description: "Desc 1",
      })
      expect(results[4]?.url).toBe("https://example.com/5")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns empty array when web.results is empty", async () => {
    const mockResponse = { web: { results: [] } }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })) as unknown as typeof fetch

    try {
      const results = await braveModule.searchBrave("nothing here", "fake-api-key")
      expect(results).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns empty array when web key is absent", async () => {
    const mockResponse = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })) as unknown as typeof fetch

    try {
      const results = await braveModule.searchBrave("nothing", "fake-api-key")
      expect(results).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("uses empty string for missing description field", async () => {
    const mockResponse = {
      web: { results: [{ title: "T", url: "https://u.com" }] },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })) as unknown as typeof fetch

    try {
      const results = await braveModule.searchBrave("q", "fake-api-key")
      expect(results[0]?.description).toBe("")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("searchBrave — error handling", () => {
  test("throws BraveSearchError on non-200 response", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("Forbidden", { status: 403 })) as unknown as typeof fetch

    try {
      await expect(braveModule.searchBrave("query", "bad-key")).rejects.toBeInstanceOf(BraveSearchError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("BraveSearchError reason includes status code on non-200", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("Forbidden", { status: 403 })) as unknown as typeof fetch

    try {
      expect.assertions(2)
      await braveModule.searchBrave("query", "bad-key").catch((e: BraveSearchError) => {
        expect(e).toBeInstanceOf(BraveSearchError)
        expect(e.reason).toContain("403")
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("throws BraveSearchError on network failure", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("network error")
    }) as unknown as typeof fetch

    try {
      await expect(braveModule.searchBrave("query", "key")).rejects.toBeInstanceOf(BraveSearchError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
