import { describe, test, expect } from "bun:test"

import { translateFromResponsesPayloadToCC } from "~/services/copilot/responses-translation"

/**
 * Tool shapes verified against Codex's own wire types in
 * `codex-rs/tools/src/responses_api.rs`:
 *
 *   ResponsesApiTool          → { name, description, strict, parameters }
 *   LoadableToolSpec          → tagged `type: "function" | "namespace"`
 *   ResponsesApiNamespace     → { name, description, tools: [...] }
 *
 * A `namespace` is a *container* of callable functions, so dropping it discards
 * every tool inside — the model is then told nothing about capabilities the
 * client believes it advertised.
 */
describe("Responses → CC tool translation", () => {
  test("translates a flat function tool", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "hi",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Gets weather",
          strict: false,
          parameters: { type: "object", properties: {} },
        },
      ],
    })

    expect(result.tools).toHaveLength(1)
    expect(result.tools?.[0]?.function.name).toBe("get_weather")
  })

  test("expands a namespace tool into its member functions", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "hi",
      tools: [
        {
          type: "namespace",
          name: "browser",
          description: "Browser tools",
          tools: [
            {
              type: "function",
              name: "open",
              description: "Open a page",
              parameters: { type: "object", properties: {} },
            },
            {
              type: "function",
              name: "click",
              description: "Click an element",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    })

    expect(result.tools).toHaveLength(2)
    expect(result.tools?.map((t) => t.function.name)).toEqual([
      "browser__open",
      "browser__click",
    ])
  })

  test("namespace members are prefixed so identical names cannot collide", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "hi",
      tools: [
        {
          type: "namespace",
          name: "alpha",
          tools: [{ type: "function", name: "run", parameters: {} }],
        },
        {
          type: "namespace",
          name: "beta",
          tools: [{ type: "function", name: "run", parameters: {} }],
        },
      ],
    })

    const names = result.tools?.map((t) => t.function.name)
    expect(names).toEqual(["alpha__run", "beta__run"])
    expect(new Set(names).size).toBe(2)
  })

  test("translates local_shell into a callable shell function", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "hi",
      tools: [{ type: "local_shell" }],
    })

    expect(result.tools).toHaveLength(1)
    expect(result.tools?.[0]?.function.name).toBe("shell")
  })

  test("translates a custom/freeform tool by name", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "hi",
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply a patch",
          format: { type: "grammar", syntax: "lark", definition: "..." },
        },
      ],
    })

    expect(result.tools).toHaveLength(1)
    expect(result.tools?.[0]?.function.name).toBe("apply_patch")
  })

  test("omits `tools` entirely when no tool has a CC equivalent", () => {
    // An empty array alongside a tool_choice trips upstream validation, so the
    // key must be absent rather than `[]`.
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "hi",
      tools: [{ type: "web_search" }, { type: "file_search" }],
    })

    expect(result.tools).toBeUndefined()
  })

  test("keeps usable tools when mixed with untranslatable built-ins", () => {
    const result = translateFromResponsesPayloadToCC({
      model: "claude-sonnet-5",
      input: "hi",
      tools: [
        { type: "web_search" },
        { type: "function", name: "get_weather", parameters: {} },
      ],
    })

    expect(result.tools).toHaveLength(1)
    expect(result.tools?.[0]?.function.name).toBe("get_weather")
  })
})
