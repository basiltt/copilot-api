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
