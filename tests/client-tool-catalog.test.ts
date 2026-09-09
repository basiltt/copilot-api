/* eslint-disable max-lines-per-function */
import { describe, expect, test } from "bun:test"

import { expandClientTool } from "~/routes/messages/client-tool-catalog"
import {
  compileToolSchema,
  parseToolInput,
  toolInputSchema,
} from "~/routes/messages/tool-input"
import {
  createToolNameMapFromAnthropicPayload,
  toAnthropicToolIdentity,
} from "~/routes/messages/tool-name-mapping"

describe("current typed client schemas", () => {
  test("browser modifier chords and legacy computer actions match the client contract", () => {
    const browser = expandClientTool({ type: "browser_toolset_20260801" }) ?? []
    const click = browser.find((tool) => tool.name === "left_click")
    expect(
      parseToolInput(
        '{"target":{"type":"ref","ref":"item"},"modifiers":"ctrl+shift"}',
        "left_click",
        click?.input_schema,
      ),
    ).toHaveProperty("modifiers", "ctrl+shift")
    for (const version of ["computer_20250124", "computer_20251124"]) {
      const tool = expandClientTool({
        type: version,
        name: "computer",
        display_width_px: 1024,
        display_height_px: 768,
        strict: true,
        defer_loading: true,
        input_examples: [{ action: "screenshot" }],
      })?.[0]
      expect(tool?.strict).toBe(true)
      expect(tool?.defer_loading).toBe(true)
      expect(tool?.input_examples).toEqual([{ action: "screenshot" }])
      expect(
        parseToolInput(
          '{"action":"screenshot"}',
          "computer",
          tool?.input_schema,
        ),
      ).toEqual({ action: "screenshot" })
      expect(() =>
        parseToolInput(
          '{"action":"zoom","region":[0,0,100,100]}',
          "computer",
          tool?.input_schema,
        ),
      ).toThrow()
      expect(() =>
        parseToolInput(
          '{"action":"key","text":"A","repeat":2}',
          "computer",
          tool?.input_schema,
        ),
      ).toThrow()
    }
    const zoom = expandClientTool({
      type: "computer_20251124",
      name: "computer",
      display_width_px: 1024,
      display_height_px: 768,
      enable_zoom: true,
    })?.[0]
    expect(
      parseToolInput(
        '{"action":"zoom","region":[0,0,100,100]}',
        "computer",
        zoom?.input_schema,
      ),
    ).toHaveProperty("region")
  })
  test("browser and computer default and opt-in members compile and preserve namespaces", () => {
    const browser = expandClientTool({ type: "browser_toolset_20260801" }) ?? []
    const computer =
      expandClientTool({ type: "computer_toolset_20260801" }) ?? []
    expect(browser).toHaveLength(27)
    expect(computer).toHaveLength(17)
    expect(browser.every((tool) => tool.toolset_name === "browser")).toBe(true)
    expect(computer.every((tool) => tool.toolset_name === "computer")).toBe(
      true,
    )
    const all =
      expandClientTool({
        type: "browser_toolset_20260801",
        configs: {
          javascript_exec: { enabled: true },
          file_upload: { enabled: true },
          read_console: { enabled: true },
          read_network: { enabled: true },
        },
      }) ?? []
    expect(all).toHaveLength(31)
    for (const tool of [...all, ...computer])
      expect(compileToolSchema(tool.input_schema)).toBeFunction()
    const screenshot = all.find((tool) => tool.name === "screenshot")
    expect(
      parseToolInput("{}", "screenshot", screenshot?.input_schema),
    ).toEqual({})
  })

  test("configs reject unknown members/keys and default-off actions need explicit enablement", () => {
    expect(() =>
      expandClientTool({ type: "browser_toolset_20260801", name: "browser" }),
    ).toThrow()
    expect(() =>
      expandClientTool({
        type: "browser_toolset_20260801",
        configs: { imaginary: {} },
      }),
    ).toThrow()
    expect(() =>
      expandClientTool({
        type: "browser_toolset_20260801",
        configs: { screenshot: { strange: true } },
      }),
    ).toThrow()
    expect(
      expandClientTool({
        type: "browser_toolset_20260801",
        configs: {
          screenshot: { enabled: false },
          javascript_exec: { defer_loading: true },
        },
      })?.some((tool) => ["javascript_exec", "screenshot"].includes(tool.name)),
    ).toBe(false)
    const names =
      expandClientTool({ type: "computer_toolset_20260801" })?.map(
        (tool) => tool.name,
      ) ?? []
    expect(() =>
      expandClientTool({
        type: "computer_toolset_20260801",
        configs: Object.fromEntries(
          names.map((name) => [name, { enabled: false }]),
        ),
      }),
    ).toThrow("at least one")
  })

  test("browser coordinate/ref targets and file upload alternatives are validated", () => {
    const tools =
      expandClientTool({
        type: "browser_toolset_20260801",
        configs: { file_upload: { enabled: true } },
      }) ?? []
    const upload = tools.find(
      (tool) => tool.name === "file_upload",
    )?.input_schema
    expect(() =>
      parseToolInput(
        '{"target":{"type":"ref","ref":"el1"}}',
        "file_upload",
        upload,
      ),
    ).toThrow()
    expect(
      parseToolInput(
        '{"target":{"type":"ref","ref":"el1"},"paths":["example.txt"]}',
        "file_upload",
        upload,
      ),
    ).toHaveProperty("paths")
    const click = tools.find((tool) => tool.name === "left_click")?.input_schema
    expect(
      parseToolInput(
        '{"target":{"type":"coordinate","x":1,"y":2}}',
        "left_click",
        click,
      ),
    ).toHaveProperty("target")
    expect(() =>
      parseToolInput(
        '{"target":{"type":"coordinate","x":1}}',
        "left_click",
        click,
      ),
    ).toThrow()
  })

  test("bash restart, memory rename/delete replacement, and editor version commands", () => {
    const bash = expandClientTool({ type: "bash_20250124", name: "bash" })?.[0]
    expect(
      parseToolInput('{"restart":true}', "bash", bash?.input_schema),
    ).toEqual({ restart: true })
    expect(() =>
      parseToolInput('{"restart":false}', "bash", bash?.input_schema),
    ).toThrow()
    const memory = expandClientTool({
      type: "memory_20250818",
      name: "memory",
    })?.[0]
    expect(
      parseToolInput(
        '{"command":"rename","old_path":"/memories/a","new_path":"/memories/b"}',
        "memory",
        memory?.input_schema,
      ),
    ).toHaveProperty("old_path")
    expect(
      parseToolInput(
        '{"command":"str_replace","path":"/memories/a","old_str":"example"}',
        "memory",
        memory?.input_schema,
      ),
    ).not.toHaveProperty("new_str")
    const editor = expandClientTool({
      type: "text_editor_20250728",
      name: "str_replace_based_edit_tool",
      max_characters: 1000,
    })?.[0]
    expect(editor?.description).toContain("1000")
    expect(() =>
      parseToolInput(
        '{"command":"undo_edit","path":"example"}',
        "editor",
        editor?.input_schema,
      ),
    ).toThrow()
  })

  test("toolset member alias cannot collide with a custom alias-shaped name", () => {
    const map = createToolNameMapFromAnthropicPayload({
      model: "claude-opus-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: "Example" }],
      tools: [
        { name: "browser__screenshot", input_schema: { type: "object" } },
        { type: "browser_toolset_20260801" },
        { type: "computer_toolset_20260801" },
      ],
    })
    const alias = map.toolsetToOpenAI?.get(
      JSON.stringify(["browser", "screenshot"]),
    )
    expect(alias).toBeDefined()
    expect(alias).not.toBe("browser__screenshot")
    expect(toAnthropicToolIdentity(alias ?? "", map)).toEqual({
      name: "screenshot",
      toolset_name: "browser",
    })
  })

  test("schema validation never mutates input or retains conflicting request-local schema ids", () => {
    const first = {
      $id: "urn:example:request",
      type: "object",
      properties: { a: { type: "string", default: "never-inserted" } },
      required: ["a"],
    }
    const validate = compileToolSchema(first)
    expect(compileToolSchema(first)).toBe(validate)
    expect(() => parseToolInput("{}", "example", first)).toThrow()
    const second = {
      $id: "urn:example:request",
      type: "object",
      properties: { b: { type: "number" } },
      required: ["b"],
    }
    expect(parseToolInput('{"b":1}', "example", second)).toEqual({ b: 1 })
    expect(() => parseToolInput('{"b":"1"}', "example", second)).toThrow()
    expect(
      toolInputSchema({
        name: "Workflow",
        input_schema: {
          type: "object",
          properties: { runId: { type: "string" } },
        },
      }).anyOf,
    ).toEqual([{ required: ["runId"] }])
  })
})
