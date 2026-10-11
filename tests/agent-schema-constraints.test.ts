import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"

import type { State } from "~/lib/state"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { knownModelMetadata } from "~/lib/known-models"
import { state } from "~/lib/state"
import {
  applyNativeAgentSchemaConstraints,
  MAX_AGENT_ENUM_VALUES,
  MAX_AGENT_SCHEMA_BYTES,
  MAX_AGENT_SCHEMA_PROPERTIES,
} from "~/routes/messages/agent-schema-constraints"
import { configureAgentSchemaConstraints } from "~/start"

let originalState: State
let originalEnv: string | undefined
let warn: ReturnType<typeof spyOn<typeof consola, "warn">>
let info: ReturnType<typeof spyOn<typeof consola, "info">>

beforeEach(() => {
  originalState = { ...state }
  originalEnv = process.env.AGENT_SCHEMA_CONSTRAINTS
  state.nativeMessages = true
  state.agentSchemaConstraints = true
  warn = spyOn(consola, "warn").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
  info = spyOn(consola, "info").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
})

afterEach(() => {
  Object.assign(state, originalState)
  if (originalEnv === undefined) delete process.env.AGENT_SCHEMA_CONSTRAINTS
  else process.env.AGENT_SCHEMA_CONSTRAINTS = originalEnv
  warn.mockRestore()
  info.mockRestore()
})

function model(): Model {
  const selected = knownModelMetadata("claude-fable-5.1")
  if (!selected) throw new Error("Missing test model")
  selected.supported_endpoints = ["/v1/messages", "/chat/completions"]
  selected.capabilities.supports.structured_outputs = true
  return selected
}

function schema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      description: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["description", "prompt"],
    additionalProperties: false,
  }
}

function payload(inputSchema = schema()): AnthropicMessagesPayload {
  return {
    model: "claude-fable-5.1",
    max_tokens: 2048,
    messages: [{ role: "user", content: "Synthetic fixture." }],
    thinking: { type: "adaptive" },
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    tools: [
      {
        name: "Agent",
        description: "Preserve the exact caller contract.",
        input_schema: inputSchema,
        cache_control: { type: "ephemeral" },
        defer_loading: false,
      },
    ],
  }
}

function expectSkipped(
  request: AnthropicMessagesPayload,
  reason: string,
  selected = model(),
): void {
  expect(applyNativeAgentSchemaConstraints(request, selected)).toBe(request)
  expect(warn).toHaveBeenLastCalledWith(
    "Agent schema constraints not applied",
    { reason },
  )
}

describe("native Agent constraint eligibility", () => {
  test("adds only strict and preserves schema, messages, and caller metadata", () => {
    const request = payload()
    const original = structuredClone(request)
    const result = applyNativeAgentSchemaConstraints(request, model())
    expect(result).toEqual({
      ...request,
      tools: request.tools?.map((tool) => ({ ...tool, strict: true })),
    })
    expect(result.tools?.[0].input_schema).toBe(request.tools?.[0].input_schema)
    expect(result.messages).toBe(request.messages)
    expect(request).toEqual(original)
    expect(warn).not.toHaveBeenCalled()
  })

  test("defaults off and validates the startup setting", () => {
    delete process.env.AGENT_SCHEMA_CONSTRAINTS
    configureAgentSchemaConstraints()
    expect(state.agentSchemaConstraints).toBe(false)
    const request = payload()
    expect(applyNativeAgentSchemaConstraints(request, model())).toBe(request)
    for (const value of ["1", " 1 "]) {
      process.env.AGENT_SCHEMA_CONSTRAINTS = value
      configureAgentSchemaConstraints()
      expect(state.agentSchemaConstraints).toBe(true)
    }
    process.env.AGENT_SCHEMA_CONSTRAINTS = "0"
    configureAgentSchemaConstraints()
    expect(state.agentSchemaConstraints).toBe(false)
    for (const value of ["true", "false", "", "yes", "2"]) {
      process.env.AGENT_SCHEMA_CONSTRAINTS = value
      expect(configureAgentSchemaConstraints).toThrow("must be 0 or 1")
    }
    process.env.AGENT_SCHEMA_CONSTRAINTS = "1"
    state.nativeMessages = false
    expect(configureAgentSchemaConstraints).toThrow(
      "requires COPILOT_NATIVE_MESSAGES=1",
    )
  })

  for (const strict of [true, false]) {
    test(`does not override explicit caller strict=${strict}`, () => {
      const request = payload()
      request.tools = request.tools?.map((tool) => ({ ...tool, strict }))
      expect(applyNativeAgentSchemaConstraints(request, model())).toBe(request)
      expect(warn).not.toHaveBeenCalled()
    })
  }

  test("does not constrain other tools or change caller tool selection", () => {
    const request = payload()
    request.tool_choice = { type: "none" }
    expect(applyNativeAgentSchemaConstraints(request, model())).toBe(request)
    request.tool_choice = { type: "tool", name: "Read" }
    expect(applyNativeAgentSchemaConstraints(request, model())).toBe(request)
    request.tool_choice = { type: "auto" }
    request.tools = [{ name: "Read", input_schema: schema() }]
    expect(applyNativeAgentSchemaConstraints(request, model())).toBe(request)
    expect(warn).not.toHaveBeenCalled()
  })

  test("requires explicit native structured-output capability, not a model-name guess", () => {
    const request = payload()
    expect(applyNativeAgentSchemaConstraints(request, undefined)).toBe(request)
    const selected = model()
    delete selected.capabilities.supports.structured_outputs
    expectSkipped(request, "catalog_not_advertised", selected)
    selected.capabilities.supports.structured_outputs = false
    expectSkipped(request, "catalog_not_advertised", selected)
    selected.capabilities.supports.structured_outputs = true
    selected.supported_endpoints = ["/chat/completions"]
    expectSkipped(request, "catalog_not_advertised", selected)
    selected.supported_endpoints = ["/v1/messages"]
    selected.vendor = "different-vendor"
    expectSkipped(request, "catalog_not_advertised", selected)
  })

  test("does not consume another strict output's shared compilation budget", () => {
    const request = payload()
    request.tools?.push({ name: "Read", input_schema: schema(), strict: true })
    expectSkipped(request, "strict_budget_in_use")
    request.tools?.pop()
    request.output_config = {
      format: { type: "json_schema", schema: schema() },
    }
    expectSkipped(request, "strict_budget_in_use")
    request.output_config = undefined
    request.tools?.push({ name: "Agent", input_schema: schema() })
    expectSkipped(request, "ambiguous_agent_declaration")
  })
})

describe("bounded Agent schemas", () => {
  for (const [name, unsupported] of [
    ["open object", { ...schema(), additionalProperties: true }],
    ["implicitly open object", { type: "object", properties: {} }],
    ["root union", { ...schema(), anyOf: [{ required: ["prompt"] }] }],
    ["references", { ...schema(), $defs: { value: { type: "string" } } }],
    ["missing required property", { ...schema(), required: ["missing"] }],
    [
      "duplicate required property",
      { ...schema(), required: ["prompt", "prompt"] },
    ],
    ["null required", { ...schema(), required: null }],
  ] as const) {
    test(`leaves ${name} unchanged`, () => {
      expectSkipped(payload(unsupported), "schema_unsupported")
    })
  }

  for (const [name, property] of [
    ["nested object", { type: "object", additionalProperties: false }],
    ["array", { type: "array", items: { type: "string" } }],
    ["type union", { type: ["string", "null"] }],
    ["single-element type array", { type: ["string"] }],
    ["pattern", { type: "string", pattern: "^x" }],
    ["minimum", { type: "number", minimum: 0 }],
    ["minimum length", { type: "string", minLength: 1 }],
    ["empty enum", { type: "string", enum: [] }],
    ["wrong-type enum", { type: "string", enum: [true] }],
    ["complex enum", { type: "string", enum: [{}] }],
    ["incompatible const", { type: "string", enum: ["a"], const: "b" }],
    ["incompatible default", { type: "string", const: "a", default: "b" }],
    ["non-finite number", { type: "number", const: Number.POSITIVE_INFINITY }],
  ] as const) {
    test(`leaves scalar ${name} unchanged`, () => {
      expectSkipped(
        payload({
          ...schema(),
          properties: { value: property },
          required: ["value"],
        }),
        "schema_unsupported",
      )
    })
  }

  for (const [type, value] of [
    ["string", "a"],
    ["boolean", false],
    ["number", 0.5],
    ["integer", 1],
    ["null", null],
  ] as const) {
    test(`preserves ${type} enum, const, and default exactly`, () => {
      const request = payload({
        ...schema(),
        properties: {
          value: {
            type,
            enum: [value],
            const: value,
            default: value,
            description: "Caller metadata",
          },
        },
        required: [],
      })
      const result = applyNativeAgentSchemaConstraints(request, model())
      expect(result.tools?.[0].strict).toBe(true)
      expect(result.tools?.[0].input_schema).toBe(
        request.tools?.[0].input_schema,
      )
    })
  }

  test("checks the exact scalar-property and enum-value bounds", () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_AGENT_SCHEMA_PROPERTIES }, (_, i) => [
        `field${i}`,
        { type: "string" },
      ]),
    )
    const request = payload({ ...schema(), properties, required: [] })
    expect(
      applyNativeAgentSchemaConstraints(request, model()).tools?.[0].strict,
    ).toBe(true)
    properties.extra = { type: "string" }
    expectSkipped(request, "schema_unsupported")
    const values = Array.from(
      { length: MAX_AGENT_ENUM_VALUES },
      (_, i) => `value${i}`,
    )
    const enumRequest = payload({
      ...schema(),
      properties: { value: { type: "string", enum: values } },
      required: [],
    })
    expect(
      applyNativeAgentSchemaConstraints(enumRequest, model()).tools?.[0].strict,
    ).toBe(true)
    values.push("extra")
    expectSkipped(enumRequest, "schema_unsupported")
  })

  test("checks UTF-8 bytes rather than character count at the exact boundary", () => {
    const bounded = { ...schema(), description: "" }
    const remaining =
      MAX_AGENT_SCHEMA_BYTES
      - Buffer.byteLength(JSON.stringify(bounded), "utf8")
    bounded.description = "x".repeat(remaining)
    const request = payload(bounded)
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBe(
      MAX_AGENT_SCHEMA_BYTES,
    )
    expect(
      applyNativeAgentSchemaConstraints(request, model()).tools?.[0].strict,
    ).toBe(true)
    bounded.description += "x"
    expectSkipped(request, "schema_unsupported")
    bounded.description = "\u00e9".repeat(remaining)
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(
      MAX_AGENT_SCHEMA_BYTES,
    )
    expectSkipped(request, "schema_unsupported")
  })

  test("unsupported-schema warnings contain no private fields, values, or schemas", () => {
    const sentinel = "PRIVATE_SYNTHETIC_VALUE"
    const request = payload({
      ...schema(),
      description: sentinel,
      properties: { [sentinel]: { type: "string", pattern: sentinel } },
      required: [sentinel],
    })
    expectSkipped(request, "schema_unsupported")
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel)
  })
})
