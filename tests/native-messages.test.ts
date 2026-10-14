/* eslint-disable max-lines, max-lines-per-function */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type {
  AnthropicMessagesPayload,
  AnthropicTool,
} from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { messageRoutes } from "~/routes/messages/route"
import { compileToolSchema } from "~/routes/messages/tool-input"
import { createToolNameMapFromAnthropicPayload } from "~/routes/messages/tool-name-mapping"
import {
  buildNativeMessagesBody,
  createNativeMessagesCompletion,
  nativeMessagesCompatibility,
  nativeMessagesRejectionReasons,
} from "~/services/copilot/create-native-messages-completion"
import { getModelReasoningEfforts } from "~/services/copilot/get-models"
import { configureNativeMessages } from "~/start"

const app = new Hono().route("/v1/messages", messageRoutes)
const originalState = { ...state }
const originalEnv = process.env.COPILOT_NATIVE_MESSAGES
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let replies: Array<() => Response>
let bodies: Array<Record<string, unknown>>
let urls: Array<string>
let logs: Array<ReturnType<typeof spyOn<typeof consola, "warn">>>

const writeTool = {
  name: "Write",
  description: "Write a file.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", minLength: 1 },
      content: { type: "string", minLength: 1 },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
} satisfies AnthropicTool

function model(endpoints = ["/v1/messages", "/chat/completions"]): Model {
  return {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    object: "model",
    vendor: "Anthropic",
    version: "5",
    model_picker_enabled: true,
    preview: false,
    supported_endpoints: endpoints,
    capabilities: {
      family: "claude-sonnet",
      tokenizer: "o200k_base",
      type: "chat",
      object: "model_capabilities",
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
        reasoning_effort: ["low", "medium", "high"],
      },
      limits: {
        max_context_window_tokens: 264_000,
        max_prompt_tokens: 200_000,
        max_output_tokens: 64_000,
      },
    },
  }
}

function payload(stream = false): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "Create the requested fixture." }],
    max_tokens: 64_000,
    stream,
    tools: [writeTool],
    tool_choice: { type: "auto" },
  }
}

function agentPayload(stream = false): AnthropicMessagesPayload {
  const request = payload(stream)
  state.agentSchemaConstraints = true
  const selected = state.models?.data[0]
  if (!selected) throw new Error("Missing test model")
  selected.capabilities.supports.structured_outputs = true
  request.tools = [
    {
      name: "Agent",
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["description", "prompt"],
        additionalProperties: false,
      },
    },
  ]
  return request
}

type NativeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | {
      type: "tool_use"
      id: string
      name: string
      inputJson: string
    }

function nativeSSE(
  blocks: Array<NativeBlock>,
  stopReason:
    | "end_turn"
    | "max_tokens"
    | "model_context_window_exceeded"
    | "tool_use"
    | "refusal" = "end_turn",
  usage: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    output_tokens?: number
  } = {},
): Response {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_native",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-5",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens ?? 17,
          output_tokens: 0,
          ...(usage.cache_read_input_tokens !== undefined ?
            { cache_read_input_tokens: usage.cache_read_input_tokens }
          : {}),
          ...(usage.cache_creation_input_tokens !== undefined ?
            { cache_creation_input_tokens: usage.cache_creation_input_tokens }
          : {}),
        },
      },
    },
  ]
  for (const [index, block] of blocks.entries()) {
    switch (block.type) {
      case "text": {
        events.push(
          {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          },
        )

        break
      }
      case "thinking": {
        events.push(
          {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: block.thinking },
          },
        )
        if (block.signature) {
          events.push({
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: block.signature },
          })
        }

        break
      }
      case "redacted_thinking": {
        events.push({
          type: "content_block_start",
          index,
          content_block: block,
        })

        break
      }
      default: {
        events.push(
          {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: block.inputJson,
            },
          },
        )
      }
    }
    events.push({ type: "content_block_stop", index })
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens ?? 5 },
    },
    { type: "message_stop" },
  )
  return new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function eventStreamResponse(
  events: Array<Record<string, unknown>>,
  onCancel?: () => void,
): Response {
  const bytes = new TextEncoder().encode(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  )
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        if (!onCancel) controller.close()
      },
      cancel() {
        onCancel?.()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function textNativeEvents(
  stopReason: "end_turn" | "model_context_window_exceeded" = "end_turn",
): Array<Record<string, unknown>> {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_native",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_input_tokens: 2,
      },
    },
    { type: "message_stop" },
  ]
}

function toolNativeEvents(
  input: Record<string, unknown>,
  fragments: Array<string>,
): Array<Record<string, unknown>> {
  const events = textNativeEvents()
  events.splice(
    1,
    3,
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call_native",
        name: "Probe",
        input,
      },
    },
    ...fragments.map((partialJson) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: partialJson },
    })),
    { type: "content_block_stop", index: 0 },
  )
  events[events.length - 2] = {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 2 },
  }
  return events
}

function queue(...responses: Array<Response>): void {
  replies = responses.map((response) => () => response)
}

function chatCompletion(text = "fallback"): Response {
  return Response.json({
    id: "chat_fallback",
    object: "chat.completion",
    created: 0,
    model: "claude-sonnet-5",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 2,
      completion_tokens: 1,
      total_tokens: 3,
    },
  })
}

function truncatedWriteCompletion(filePath: string): Response {
  return Response.json({
    id: "chat_truncated",
    object: "chat.completion",
    created: 0,
    model: "claude-sonnet-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "write_partial",
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({ file_path: filePath }),
              },
            },
          ],
        },
        finish_reason: "length",
      },
    ],
    usage: {
      prompt_tokens: 2,
      completion_tokens: 16_000,
      total_tokens: 16_002,
    },
  })
}

function send(request = payload(), signal?: AbortSignal): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    }),
  )
}

beforeEach(() => {
  bodies = []
  urls = []
  replies = []
  Object.assign(state, {
    nativeMessages: true,
    agentSchemaConstraints: false,
    writeToolRecovery: true,
    toolSearchRecovery: true,
    structuredOutputRecovery: true,
    copilotToken: "test-token",
    vsCodeVersion: "1.0",
    accountType: "individual",
    models: { object: "list", data: [model()] },
    webSearchProvider: "off",
    rateLimitSeconds: undefined,
    burstCount: undefined,
    burstMinSpacingMs: 0,
  })
  logs = (["debug", "warn", "error", "info"] as const).map((method) =>
    spyOn(consola, method).mockImplementation(
      Object.assign(() => undefined, { raw: () => undefined }),
    ),
  )
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON request body")
        urls.push(url instanceof Request ? url.url : url.toString())
        bodies.push(JSON.parse(init.body) as Record<string, unknown>)
        const next = replies.shift()
        if (!next) throw new Error("Unexpected extra upstream request")
        return Promise.resolve(next())
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
})

afterEach(() => {
  fetchSpy.mockRestore()
  for (const log of logs) log.mockRestore()
  for (const key of Object.keys(state)) {
    if (!Object.hasOwn(originalState, key)) Reflect.deleteProperty(state, key)
  }
  Object.assign(state, originalState)
  if (originalEnv === undefined) delete process.env.COPILOT_NATIVE_MESSAGES
  else process.env.COPILOT_NATIVE_MESSAGES = originalEnv
})

describe("native Messages routing and body", () => {
  test("reads only well-formed explicit effort lists from raw model metadata", () => {
    expect(getModelReasoningEfforts(undefined)).toBeUndefined()
    expect(getModelReasoningEfforts({ id: "claude-fable-5.1" })).toBeUndefined()
    for (const reasoningEffort of ["max", [true, "max"], null]) {
      expect(
        getModelReasoningEfforts({
          id: "claude-fable-5.1",
          capabilities: { supports: { reasoning_effort: reasoningEffort } },
        }),
      ).toBeUndefined()
    }
    const efforts = ["low", "xhigh", "max"]
    expect(
      getModelReasoningEfforts({
        id: "claude-fable-5.1",
        capabilities: { supports: { reasoning_effort: efforts } },
      }),
    ).toBe(efforts)
  })

  test("configuration is explicit and defaults off", () => {
    delete process.env.COPILOT_NATIVE_MESSAGES
    configureNativeMessages()
    expect(state.nativeMessages).toBe(false)
    process.env.COPILOT_NATIVE_MESSAGES = "1"
    configureNativeMessages()
    expect(state.nativeMessages).toBe(true)
    process.env.COPILOT_NATIVE_MESSAGES = "true"
    expect(configureNativeMessages).toThrow("must be 0 or 1")
  })

  test("requires the flag, raw catalog endpoint and supported request shape", () => {
    const request = payload()
    state.nativeMessages = false
    expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
      "native_disabled",
    )
    state.nativeMessages = true
    expect(nativeMessagesCompatibility(request, ["/chat/completions"])).toBe(
      "model_not_advertised",
    )
    expect(
      nativeMessagesCompatibility(
        { ...request, mcp_servers: [{ url: "https://invalid.example" }] },
        ["/v1/messages"],
      ),
    ).toBe("request_unsupported")
    expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
      "native_selected",
    )
    expect(
      nativeMessagesCompatibility(
        {
          ...request,
          mcp_servers: [],
          container: null as never,
          context_management: null as never,
        },
        ["/v1/messages"],
      ),
    ).toBe("native_selected")

    for (const name of ["ToolSearch", "StructuredOutput"]) {
      expect(
        nativeMessagesCompatibility(
          {
            ...request,
            tools: [
              {
                name,
                input_schema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
              },
            ],
          },
          ["/v1/messages"],
        ),
      ).toBe("native_selected")
    }
  })

  for (const effort of ["xhigh", "max"] as const) {
    test(`${effort} requires an explicit matching catalog effort capability`, () => {
      const request = { ...payload(), output_config: { effort } }
      for (const efforts of [
        undefined,
        [],
        ["low", "medium", "high"],
        "max" as never,
      ]) {
        expect(
          nativeMessagesCompatibility(request, ["/v1/messages"], efforts),
        ).toBe("request_unsupported")
      }
      expect(
        nativeMessagesCompatibility(request, ["/v1/messages"], [effort]),
      ).toBe("native_selected")
      request.context_management = { edits: [] }
      expect(nativeMessagesRejectionReasons(request, [effort])).toEqual([
        "context_management",
      ])
      state.nativeMessages = false
      expect(
        nativeMessagesCompatibility(request, ["/v1/messages"], [effort]),
      ).toBe("native_disabled")
    })
  }

  test("reports all fixed native rejection reasons in deterministic order without values", () => {
    const privateSentinel = "never-log-this-request-value"
    const unsafe = {
      ...payload(),
      max_tokens: Number.NaN,
      tools: [
        {
          type: "bash_20250124",
          name: "bash",
          private_option: privateSentinel,
        },
      ],
      mcp_servers: [{ url: privateSentinel }],
      container: { id: privateSentinel },
      context_management: { strategy: privateSentinel },
      output_config: {
        effort: "max",
        format: {
          type: "json_schema",
          schema: { description: privateSentinel },
        },
      },
      system: [{ type: privateSentinel }],
      messages: [
        { role: "system", content: privateSentinel },
        {
          role: "user",
          content: [
            null,
            {
              type: "tool_result",
              tool_use_id: privateSentinel,
            },
            {
              type: "tool_result",
              tool_use_id: privateSentinel,
              content: [{ type: "browser_state", tabs: [] }],
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: 1, signature: "" },
            { type: "redacted_thinking", data: "" },
            {
              type: "tool_use",
              id: 1,
              name: privateSentinel,
              input: privateSentinel,
            },
            {
              type: "server_tool_use",
              id: privateSentinel,
              name: privateSentinel,
              input: {},
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    const reasons = nativeMessagesRejectionReasons(unsafe)
    expect(reasons).toEqual([
      "typed_tools",
      "mcp_servers",
      "container",
      "context_management",
      "output_format",
      "effort_unsupported",
      "system_block_unsupported",
      "message_role_system",
      "user_block_unsupported",
      "tool_result_content_missing",
      "tool_result_content_unsupported",
      "thinking_invalid",
      "thinking_signature_missing",
      "redacted_thinking_invalid",
      "tool_use_invalid",
      "assistant_block_unsupported",
      "max_tokens_invalid",
    ])
    expect(JSON.stringify(reasons)).not.toContain(privateSentinel)
    expect(nativeMessagesCompatibility(unsafe, ["/v1/messages"])).toBe(
      "request_unsupported",
    )
  })

  test("classifies unsupported message roles without retaining their values", () => {
    const privateRole = "private-role-never-log"
    const request = {
      ...payload(),
      messages: [
        null,
        { content: "missing role" },
        { role: "system", content: "system instruction" },
        { role: "developer", content: "developer instruction" },
        { role: "tool", content: "tool result" },
        { role: privateRole, content: "unknown role" },
        { role: 42, content: "invalid role" },
      ],
    } as unknown as AnthropicMessagesPayload

    const reasons = nativeMessagesRejectionReasons(request)
    expect(reasons).toEqual([
      "message_nonobject",
      "message_role_absent",
      "message_role_system",
      "message_role_system_nonprefix",
      "message_role_developer",
      "message_role_tool",
      "message_role_other",
    ])
    expect(JSON.stringify(reasons)).not.toContain(privateRole)
    expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
      "request_unsupported",
    )
  })

  test("distinguishes a leading system prefix from a later system message", () => {
    expect(
      nativeMessagesRejectionReasons({
        ...payload(),
        messages: [
          { role: "system", content: "First." },
          { role: "system", content: "Second." },
          { role: "user", content: "Continue." },
        ],
      }),
    ).toEqual(["message_role_system"])

    expect(
      nativeMessagesRejectionReasons({
        ...payload(),
        messages: [
          { role: "user", content: "Before." },
          { role: "system", content: "Later." },
          { role: "user", content: "After." },
        ],
      }),
    ).toEqual(["message_role_system", "message_role_system_nonprefix"])
  })

  for (const modelId of [
    "claude-fable-5.1",
    "claude-fable-5-1",
    "claude-opus-5.5",
    "claude-opus-5-5",
  ]) {
    test(`${modelId}: documented text system-message placement is native-compatible`, () => {
      const request = {
        ...payload(),
        model: modelId,
        messages: [
          { role: "user", content: "Synthetic task." },
          { role: "system", content: "Synthetic later guidance." },
        ],
      } satisfies AnthropicMessagesPayload
      expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
        "native_selected",
      )
      expect(nativeMessagesRejectionReasons(request)).toEqual([])
    })
  }

  test("native system-message support never moves instructions or drops unsupported semantics", () => {
    const request = { ...payload(), model: "claude-fable-5.1" }
    const user = { role: "user", content: "Synthetic task." }
    const system = { role: "system", content: "Synthetic instruction." }
    const assistant = { role: "assistant", content: "Synthetic reply." }
    const unsupportedHistories = [
      [system, user],
      [user, system, user],
      [user, assistant, system],
      [user, { ...system, clear_at: "next_user_message" }],
      [user, { ...system, output_config: { effort: "low" } }],
      [
        user,
        {
          ...system,
          content: [{ type: "tool_removal", tool: { name: "Write" } }],
        },
      ],
      [user, { ...system, content: [{ type: "text", text: 42 }] }],
      [user, { ...system, content: [] }],
      [user, { ...system, content: "" }],
    ]
    for (const messages of unsupportedHistories) {
      const candidate = { ...request, messages } as AnthropicMessagesPayload
      const original = structuredClone(candidate)
      expect(nativeMessagesCompatibility(candidate, ["/v1/messages"])).toBe(
        "request_unsupported",
      )
      expect(nativeMessagesRejectionReasons(candidate)).toContain(
        "message_role_system",
      )
      expect(candidate).toEqual(original)
    }
    for (const modelId of ["claude-sonnet-5", "unverified-native-model"]) {
      expect(
        nativeMessagesCompatibility(
          {
            ...request,
            model: modelId,
            messages: [user, system],
          } as AnthropicMessagesPayload,
          ["/v1/messages"],
        ),
      ).toBe("request_unsupported")
    }
  })

  test("native system-message support preserves unsigned-thinking rejection", () => {
    const request = {
      ...payload(),
      model: "claude-fable-5.1",
      messages: [
        { role: "user", content: "Synthetic task." },
        { role: "system", content: "Synthetic later guidance." },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Unsigned legacy state." }],
        },
        { role: "user", content: "Continue." },
      ],
    } satisfies AnthropicMessagesPayload
    expect(nativeMessagesRejectionReasons(request)).toEqual([
      "thinking_signature_missing",
    ])
    expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
      "request_unsupported",
    )
  })

  test("keeps empty tool results eligible but distinguishes absent and unsupported content", () => {
    const request = payload()
    request.messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_empty", content: [] },
        ],
      },
    ]
    expect(nativeMessagesRejectionReasons(request)).toEqual([])

    const missing = structuredClone(request) as unknown as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    Reflect.deleteProperty(missing.messages[0].content[0], "content")
    expect(
      nativeMessagesRejectionReasons(
        missing as unknown as AnthropicMessagesPayload,
      ),
    ).toEqual(["tool_result_content_missing"])

    const unsupported = structuredClone(request) as unknown as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    unsupported.messages[0].content[0].content = [
      { type: "browser_state", tabs: [] },
    ]
    expect(
      nativeMessagesRejectionReasons(
        unsupported as unknown as AnthropicMessagesPayload,
      ),
    ).toEqual(["tool_result_content_unsupported"])
  })

  test("malformed content containers remain bounded request_unsupported diagnostics", () => {
    const typed = [{ type: "bash_20250124", name: "bash" }]
    for (const malformed of [
      {
        ...payload(),
        tools: typed,
        system: [null],
      },
      {
        ...payload(),
        tools: typed,
        messages: [{ role: "user", content: null }],
      },
      {
        ...payload(),
        tools: typed,
        messages: null,
      },
    ] as Array<unknown>) {
      const request = malformed as AnthropicMessagesPayload
      expect(() => nativeMessagesRejectionReasons(request)).not.toThrow()
      expect(nativeMessagesRejectionReasons(request)[0]).toBe("typed_tools")
      expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
        "request_unsupported",
      )
    }
    expect(
      nativeMessagesRejectionReasons({
        ...payload(),
        tools: typed,
        system: [null],
      } as unknown as AnthropicMessagesPayload),
    ).toEqual(["typed_tools", "system_block_unsupported"])
    expect(
      nativeMessagesRejectionReasons({
        ...payload(),
        tools: typed,
        messages: [{ role: "user", content: null }],
      } as unknown as AnthropicMessagesPayload),
    ).toEqual(["typed_tools", "message_content_invalid"])
  })

  test("bounded output warning includes only fixed rejection reasons", async () => {
    const privatePath = "private/never-log-this-path.ts"
    const request = payload()
    request.tools = [writeTool, { type: "bash_20250124", name: "bash" }]
    queue(truncatedWriteCompletion(privatePath))

    const response = await send(request)
    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    expect(captured).toContain("Upstream tool output reached token limit")
    expect(captured).toContain('"nativeRouting":"request_unsupported"')
    expect(captured).toContain('"nativeRejectionReasons":["typed_tools"]')
    expect(captured).not.toContain(privatePath)
  })

  test("system-role fallback preserves order and reports only its fixed subtype", async () => {
    const privateInstruction = "private-system-instruction"
    const request = payload()
    request.messages = [
      { role: "user", content: "Before." },
      { role: "system", content: privateInstruction },
      { role: "user", content: "After." },
    ]
    queue(truncatedWriteCompletion("private/role-fixture.ts"))

    const response = await send(request)
    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(bodies[0].messages).toEqual([
      { role: "user", content: "Before." },
      { role: "system", content: privateInstruction },
      { role: "user", content: "After." },
    ])
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    expect(captured).toContain(
      '"nativeRejectionReasons":["message_role_system","message_role_system_nonprefix"]',
    )
    expect(captured).not.toContain(privateInstruction)
  })

  test("keeps native Workflow declarations unchanged while enforcing selector refinement locally", () => {
    const request = payload()
    request.tools = [
      {
        name: "Workflow",
        input_schema: {
          type: "object",
          properties: {
            runId: { type: "string" },
            script: { type: "string" },
            scriptPath: { type: "string" },
          },
        },
      },
    ]
    request.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "workflow_call",
            name: "Workflow",
            input: { runId: "existing" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "workflow_call",
            content: [
              {
                type: "tool_reference",
                tool_name: "Workflow",
              },
            ],
          },
        ],
      },
    ]
    const map = createToolNameMapFromAnthropicPayload(request)
    const body = buildNativeMessagesBody(request, map)
    expect(body.tools).toEqual(request.tools)
    const validationSchema = map.inputSchemas?.Workflow
    if (!validationSchema) throw new Error("Workflow validation schema missing")
    expect(validationSchema.anyOf).toEqual([
      { required: ["script"] },
      { required: ["scriptPath"] },
      { required: ["runId"] },
    ])
    const validate = compileToolSchema(validationSchema)
    expect(validate({})).toBe(false)
    expect(validate({ runId: "existing" })).toBe(true)
    expect(body.messages).toEqual(request.messages)

    request.messages.push({
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: "server_search",
          name: "web_search",
          input: { query: "fixture" },
        },
      ],
    })
    expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
      "request_unsupported",
    )

    request.messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "legacy unsigned thought" }],
      },
      { role: "user", content: "Continue." },
    ]
    expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
      "request_unsupported",
    )
    request.messages[0] = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "native thought",
          signature: "native_signature",
        },
      ],
    }
    expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
      "native_selected",
    )
  })

  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    test(`caller root ${keyword} remains intact on the compatible transport`, () => {
      const request = payload()
      request.tools = [
        {
          name: "Workflow",
          input_schema: {
            type: "object",
            properties: { script: { type: "string" } },
            [keyword]: [{ required: ["script"] }],
          },
        },
      ]
      const original = structuredClone(request)
      expect(nativeMessagesRejectionReasons(request)).toEqual([
        "tool_schema_root_composition",
      ])
      expect(nativeMessagesCompatibility(request, ["/v1/messages"])).toBe(
        "request_unsupported",
      )
      expect(request).toEqual(original)
    })
  }

  test("preserves two-turn tool IDs, result linkage and thinking signature", () => {
    const request = payload()
    request.messages = [
      { role: "user", content: "Use the tool." },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "private",
            signature: "signed-native-state",
          },
          {
            type: "tool_use",
            id: "call_1",
            name: "Write",
            input: { file_path: "fixture.ts", content: "ok" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "completed",
          },
        ],
      },
    ]
    const body = buildNativeMessagesBody(
      request,
      createToolNameMapFromAnthropicPayload(request),
    )

    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(64_000)
    expect(body.messages).toEqual(request.messages)
  })

  test("maps tool_reference names with the same request-scoped alias", () => {
    const longName = `mcp__toolset__${"long_name_".repeat(8)}`
    const request = payload()
    request.tools = [
      {
        name: longName,
        input_schema: { type: "object", properties: {} },
      },
    ]
    request.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "aliased_call",
            name: longName,
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_reference", tool_name: longName },
          {
            type: "tool_result",
            tool_use_id: "aliased_call",
            content: [{ type: "tool_reference", tool_name: longName }],
          },
        ],
      },
    ]
    const body = buildNativeMessagesBody(
      request,
      createToolNameMapFromAnthropicPayload(request),
    )
    const alias = (body.tools as Array<{ name: string }>)[0].name
    expect(alias).not.toBe(longName)
    expect(JSON.stringify(body.messages)).not.toContain(longName)
    expect(JSON.stringify(body.messages)).toContain(alias)
  })
})

describe("native empty tool-input deltas", () => {
  for (const stream of [false, true]) {
    test(`preserves a real no-input tool and signed thinking (stream=${stream})`, async () => {
      const request = payload(stream)
      request.tools = [
        {
          name: "CronList",
          input_schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ]
      queue(
        nativeSSE(
          [
            {
              type: "thinking",
              thinking: "List scheduled tasks.",
              signature: "sig_no_input",
            },
            {
              type: "tool_use",
              id: "call_no_input",
              name: "CronList",
              inputJson: "",
            },
          ],
          "tool_use",
        ),
      )

      const response = await send(request)
      const output = await response.text()
      expect(response.status).toBe(200)
      expect(output).not.toContain('"type":"error"')
      expect(output).toContain('"stop_reason":"tool_use"')
      expect(output).toContain("sig_no_input")
      expect(output).toContain("call_no_input")
      if (stream) {
        expect(output.match(/event: message_stop/g)).toHaveLength(1)
        expect(output).toContain('"partial_json":"{}"')
      } else {
        expect(JSON.parse(output)).toMatchObject({
          content: [
            { type: "thinking", signature: "sig_no_input" },
            {
              type: "tool_use",
              id: "call_no_input",
              name: "CronList",
              input: {},
            },
          ],
        })
      }
      expect(bodies[0].tools).toEqual(request.tools)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(urls[0]).toEndWith("/v1/messages")
    })

    test.each([
      { initial: {}, fragments: [], expected: {} },
      { initial: {}, fragments: ["", ""], expected: {} },
      {
        initial: { value: "retained" },
        fragments: [""],
        expected: { value: "retained" },
      },
      {
        initial: {},
        fragments: ["", '{"value":', '"retained"}', ""],
        expected: { value: "retained" },
      },
    ])(
      `empty fragments never replace provider input (stream=${stream}, fragments=$fragments)`,
      async ({ initial, fragments, expected }) => {
        const request = payload(stream)
        request.tools = [
          {
            name: "Probe",
            input_schema: {
              type: "object",
              properties: { value: { type: "string" } },
              additionalProperties: false,
            },
          },
        ]
        queue(eventStreamResponse(toolNativeEvents(initial, fragments)))

        const response = await send(request)
        const output = await response.text()
        expect(response.status).toBe(200)
        expect(output).not.toContain('"type":"error"')
        expect(output).toContain('"stop_reason":"tool_use"')
        expect(output).toContain('"id":"call_native"')
        if (stream) {
          expect(output).toContain(
            `"partial_json":${JSON.stringify(JSON.stringify(expected))}`,
          )
          expect(output.match(/event: message_stop/g)).toHaveLength(1)
        } else {
          expect(JSON.parse(output)).toMatchObject({
            content: [{ type: "tool_use", name: "Probe", input: expected }],
          })
        }
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      },
    )

    test(`empty fragments do not bypass required arguments or release siblings (stream=${stream})`, async () => {
      const request = payload(stream)
      request.tools = [
        {
          name: "EmptyProbe",
          input_schema: { type: "object", additionalProperties: false },
        },
        {
          name: "RequiredProbe",
          input_schema: {
            type: "object",
            properties: {
              value: { type: "string", default: "never-inserted" },
            },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ]
      queue(
        nativeSSE(
          [
            {
              type: "tool_use",
              id: "valid_sibling",
              name: "EmptyProbe",
              inputJson: "",
            },
            {
              type: "tool_use",
              id: "invalid_required",
              name: "RequiredProbe",
              inputJson: "",
            },
          ],
          "tool_use",
        ),
      )

      const response = await send(request)
      const output = await response.text()
      expect(response.status).toBe(stream ? 200 : 502)
      expect(output).toContain("required at $")
      expect(output).not.toContain('"type":"tool_use"')
      expect(output).not.toContain("valid_sibling")
      expect(output).not.toContain("never-inserted")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    test.each([" \t\n", "{", "null", "[]", '"text"', "0"])(
      `nonempty malformed or non-object fragments remain errors (stream=${stream}, input=%j)`,
      async (inputJson) => {
        const request = payload(stream)
        request.tools = [{ name: "Probe", input_schema: { type: "object" } }]
        queue(eventStreamResponse(toolNativeEvents({}, ["", inputJson, ""])))
        const response = await send(request)
        const output = await response.text()
        expect(response.status).toBe(stream ? 200 : 502)
        expect(output).toContain(
          "Native Messages upstream returned an invalid response.",
        )
        expect(output).not.toContain('"type":"tool_use"')
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      },
    )

    test(`empty fragments cannot hide mixed input representations (stream=${stream})`, async () => {
      const request = payload(stream)
      request.tools = [{ name: "Probe", input_schema: { type: "object" } }]
      queue(
        eventStreamResponse(
          toolNativeEvents({ value: "original" }, ["", '{"value":"changed"}']),
        ),
      )
      const response = await send(request)
      const output = await response.text()
      expect(response.status).toBe(stream ? 200 : 502)
      expect(output).toContain(
        "Native Messages upstream returned an invalid response.",
      )
      expect(output).not.toContain('"type":"tool_use"')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    test.each([
      "refusal",
      "max_tokens",
      "model_context_window_exceeded",
    ] as const)(
      `empty fragments do not change %s precedence (stream=${stream})`,
      async (reason) => {
        const request = payload(stream)
        request.tools = [{ name: "Probe", input_schema: { type: "object" } }]
        queue(
          nativeSSE(
            [
              {
                type: "tool_use",
                id: "call_stopped",
                name: "Probe",
                inputJson: "",
              },
            ],
            reason,
          ),
        )
        const response = await send(request)
        const output = await response.text()
        expect(response.status).toBe(200)
        expect(output).toContain(
          `"stop_reason":"${reason === "refusal" ? "refusal" : "max_tokens"}"`,
        )
        expect(output).not.toContain('"stop_reason":"tool_use"')
        expect(output).not.toContain('"type":"tool_use"')
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      },
    )

    test(`empty input still requires terminal message_stop (stream=${stream})`, async () => {
      const request = payload(stream)
      request.tools = [{ name: "Probe", input_schema: { type: "object" } }]
      queue(eventStreamResponse(toolNativeEvents({}, [""]).slice(0, -1)))
      const response = await send(request)
      const output = await response.text()
      expect(response.status).toBe(stream ? 200 : 502)
      expect(output).toContain(
        "Native Messages upstream returned an invalid response.",
      )
      expect(output).not.toContain('"type":"tool_use"')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  }
})

describe("native Agent constraint safety", () => {
  for (const stream of [false, true]) {
    test(`stream=${stream}: preserves valid actions, call IDs, and signed thinking without correction`, async () => {
      const request = agentPayload(stream)
      request.thinking = { type: "adaptive" }
      const input = {
        description: "Inspect fixture",
        prompt: "Read-only synthetic task.",
      }
      queue(
        nativeSSE(
          [
            {
              type: "thinking",
              thinking: "Synthetic fixture.",
              signature: "sig_fixture",
            },
            {
              type: "tool_use",
              id: "call_agent",
              name: "Agent",
              inputJson: JSON.stringify(input),
            },
          ],
          "tool_use",
        ),
      )
      const response = await send(request)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain("call_agent")
      expect(text).toContain("sig_fixture")
      expect(text).toContain('"stop_reason":"tool_use"')
      expect(bodies[0].tools).toEqual(
        request.tools?.map((tool) => ({ ...tool, strict: true })),
      )
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    test(`stream=${stream}: still rejects a provider's invalid constrained output atomically`, async () => {
      const request = agentPayload(stream)
      request.tools?.push({
        name: "Sibling",
        input_schema: { type: "object", additionalProperties: false },
      })
      queue(
        nativeSSE(
          [
            {
              type: "tool_use",
              id: "call_sibling",
              name: "Sibling",
              inputJson: "{}",
            },
            {
              type: "tool_use",
              id: "call_agent",
              name: "Agent",
              inputJson: JSON.stringify({
                description: "Inspect fixture",
                prompt: "Read-only synthetic task.",
                diagnostic_tag: "PRIVATE_SYNTHETIC_VALUE",
              }),
            },
          ],
          "tool_use",
        ),
      )
      const response = await send(request)
      expect(response.status).toBe(stream ? 200 : 502)
      const text = await response.text()
      expect(text).toContain("additionalProperties at $")
      expect(text).not.toContain('"type":"tool_use"')
      expect(text).not.toContain("PRIVATE_SYNTHETIC_VALUE")
      expect(text).not.toContain("diagnostic_tag")
      expect(bodies[0].tools).toEqual([
        { ...request.tools?.[0], strict: true },
        request.tools?.[1],
      ])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    for (const reason of ["refusal", "max_tokens"] as const) {
      test(`stream=${stream}: ${reason} takes precedence over invalid constrained input`, async () => {
        const request = agentPayload(stream)
        queue(
          nativeSSE(
            [
              { type: "text", text: "Synthetic terminal fixture." },
              {
                type: "tool_use",
                id: "call_agent",
                name: "Agent",
                inputJson: "{}",
              },
            ],
            reason,
          ),
        )
        const response = await send(request)
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).not.toContain('"stop_reason":"tool_use"')
        expect(text).not.toContain("arguments do not match")
        if (reason === "max_tokens")
          expect(text).toContain('"stop_reason":"max_tokens"')
        else expect(text).not.toContain('"type":"tool_use"')
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      })
    }

    test(`stream=${stream}: compilation errors never downgrade or retry unconstrained`, async () => {
      const request = agentPayload(stream)
      queue(
        Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Schema is too complex for compilation.",
            },
          },
          { status: 400 },
        ),
      )
      const response = await send(request)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain("Schema is too complex")
      expect(urls).toEqual(["https://api.githubcopilot.com/v1/messages"])
      expect(bodies[0].tools).toEqual(
        request.tools?.map((tool) => ({ ...tool, strict: true })),
      )
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    test(`stream=${stream}: upstream policy rejection remains a single failed native attempt`, async () => {
      const request = agentPayload(stream)
      queue(
        Response.json(
          {
            type: "error",
            error: {
              type: "permission_error",
              message: "Synthetic policy rejection.",
            },
          },
          { status: 403 },
        ),
      )
      const response = await send(request)
      expect(response.status).toBe(403)
      const text = await response.text()
      expect(text).toContain("Synthetic policy rejection")
      expect(text).not.toContain('"type":"tool_use"')
      expect(urls).toEqual(["https://api.githubcopilot.com/v1/messages"])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  }

  test("an incompatible request remains compatible without a false strict-generation guarantee", async () => {
    const request = agentPayload()
    request.messages = [
      ...request.messages,
      { role: "system", content: "Synthetic legacy history." },
      { role: "user", content: "Continue." },
    ]
    queue(chatCompletion())
    const response = await send(request)
    expect(response.status).toBe(200)
    await response.text()
    expect(urls).toEqual(["https://api.githubcopilot.com/chat/completions"])
    const tools = bodies[0].tools as Array<{ function: { strict?: boolean } }>
    expect(tools[0].function.strict).toBeUndefined()
    expect(logs[1]).toHaveBeenCalledWith(
      "Agent schema constraints not applied",
      {
        reason: "native_unavailable",
        nativeRouting: "request_unsupported",
        nativeRejectionReasons: [
          "message_role_system",
          "message_role_system_nonprefix",
        ],
      },
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  for (const routing of ["native_disabled", "model_not_advertised"] as const) {
    test(`skipped Agent constraints identify ${routing} without inventing a request defect`, async () => {
      const request = agentPayload()
      if (routing === "native_disabled") state.nativeMessages = false
      else
        state.models = { object: "list", data: [model(["/chat/completions"])] }
      queue(chatCompletion())
      const response = await send(request)
      expect(response.status).toBe(200)
      await response.text()
      expect(logs[1]).toHaveBeenCalledWith(
        "Agent schema constraints not applied",
        {
          reason: "native_unavailable",
          nativeRouting: routing,
          nativeRejectionReasons: [],
        },
      )
      expect(urls).toEqual(["https://api.githubcopilot.com/chat/completions"])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  }

  test("skipped Agent constraints report every history blocker without private values", async () => {
    const privateValue = "private-routing-fixture-never-log"
    const request = agentPayload()
    request.messages = [
      { role: "user", content: privateValue },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: privateValue },
          { type: "text", text: privateValue },
        ],
      },
      { role: "system", content: privateValue },
      { role: "user", content: privateValue },
    ]
    const original = structuredClone(request)
    queue(chatCompletion())
    const response = await send(request)
    expect(response.status).toBe(200)
    await response.text()
    expect(logs[1]).toHaveBeenCalledWith(
      "Agent schema constraints not applied",
      {
        reason: "native_unavailable",
        nativeRouting: "request_unsupported",
        nativeRejectionReasons: [
          "thinking_signature_missing",
          "message_role_system",
          "message_role_system_nonprefix",
        ],
      },
    )
    expect(JSON.stringify(logs[1].mock.calls)).not.toContain(privateValue)
    expect(request).toEqual(original)
    expect(urls).toEqual(["https://api.githubcopilot.com/chat/completions"])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe("native Messages request pipeline", () => {
  test("valid non-streaming Write uses one native SSE call and preserves usage", async () => {
    queue(
      nativeSSE(
        [
          { type: "thinking", thinking: "plan", signature: "sig_1" },
          {
            type: "tool_use",
            id: "call_native",
            name: "Write",
            inputJson:
              '{"file_path":"fixture.ts","content":"export const ok = true"}',
          },
        ],
        "tool_use",
        {
          input_tokens: 19,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
          output_tokens: 7,
        },
      ),
    )

    const response = await send()
    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      stop_reason: string
      content: Array<unknown>
    }
    expect(result).toMatchObject({
      id: "msg_native",
      model: "claude-sonnet-5",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "plan", signature: "sig_1" },
        {
          type: "tool_use",
          id: "call_native",
          name: "Write",
          input: {
            file_path: "fixture.ts",
            content: "export const ok = true",
          },
        },
      ],
      usage: {
        input_tokens: 19,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(urls[0]).toEndWith("/v1/messages")
    expect(bodies[0]).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 64_000,
      stream: true,
    })
  })

  test("native streaming preserves thinking signature and validated tool input", async () => {
    queue(
      nativeSSE(
        [
          { type: "thinking", thinking: "plan", signature: "sig_stream" },
          {
            type: "tool_use",
            id: "call_stream",
            name: "Write",
            inputJson: '{"file_path":"fixture.ts","content":"ok"}',
          },
        ],
        "tool_use",
        { cache_creation_input_tokens: 4 },
      ),
    )

    const response = await send(payload(true))
    const output = await response.text()
    expect(response.status).toBe(200)
    expect(output).toContain('"type":"thinking_delta","thinking":"plan"')
    expect(output).toContain(
      '"type":"signature_delta","signature":"sig_stream"',
    )
    expect(output).toContain('"id":"call_stream"')
    expect(output).toContain('"stop_reason":"tool_use"')
    expect(output).toContain('"cache_creation_input_tokens":4')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(bodies[0].stream).toBe(true)
  })

  test("completed invalid Write is repaired once through native SSE", async () => {
    queue(
      nativeSSE(
        [
          {
            type: "tool_use",
            id: "call_original",
            name: "Write",
            inputJson: '{"file_path":"fixture.ts"}',
          },
        ],
        "tool_use",
      ),
      nativeSSE(
        [
          {
            type: "tool_use",
            id: "call_repair",
            name: "Write",
            inputJson: '{"file_path":"fixture.ts","content":"fixed"}',
          },
        ],
        "tool_use",
      ),
    )

    const response = await send()
    const result = (await response.json()) as {
      stop_reason: string
      content: Array<unknown>
    }
    expect(response.status).toBe(200)
    expect(result).toMatchObject({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "call_original",
          name: "Write",
          input: { file_path: "fixture.ts", content: "fixed" },
        },
      ],
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(bodies.map((body) => body.stream)).toEqual([true, true])
    expect(bodies.map((body) => body.max_tokens)).toEqual([64_000, 64_000])
  })

  test("streaming StructuredOutput repair stays native and emits only corrected input", async () => {
    const request = payload(true)
    request.tools = [
      {
        name: "StructuredOutput",
        input_schema: {
          type: "object",
          properties: { answer: { type: "string", minLength: 1 } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    ]
    queue(
      nativeSSE(
        [
          {
            type: "tool_use",
            id: "structured_original",
            name: "StructuredOutput",
            inputJson: "{}",
          },
        ],
        "tool_use",
      ),
      nativeSSE(
        [
          {
            type: "tool_use",
            id: "structured_repair",
            name: "StructuredOutput",
            inputJson: '{"answer":"fixed"}',
          },
        ],
        "tool_use",
      ),
    )

    const response = await send(request)
    const output = await response.text()
    expect(response.status).toBe(200)
    expect(output).toContain('"id":"structured_original"')
    expect(output).toContain(
      String.raw`"partial_json":"{\"answer\":\"fixed\"}"`,
    )
    expect(output).not.toContain("structured_repair")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(urls.every((url) => url.endsWith("/v1/messages"))).toBe(true)
    expect(bodies.map((body) => body.stream)).toEqual([true, true])
  })

  test("signed native thinking blocks unsafe Write correction without another call", async () => {
    queue(
      nativeSSE(
        [
          {
            type: "thinking",
            thinking: "provider context",
            signature: "signed_context",
          },
          {
            type: "tool_use",
            id: "call_original",
            name: "Write",
            inputJson: '{"file_path":"fixture.ts"}',
          },
        ],
        "tool_use",
      ),
    )

    const response = await send()
    expect(response.status).toBe(502)
    expect(await response.text()).toContain("signed native thinking")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test.each(["Write", "ToolSearch", "StructuredOutput"])(
    "signed native thinking from a %s repair is rejected",
    async (name) => {
      const request = payload()
      let initialInput = '{"file_path":"fixture.ts"}'
      let repairedInput =
        '{"file_path":"fixture.ts","content":"corrected content"}'
      if (name === "StructuredOutput") {
        request.tools = [
          {
            name,
            input_schema: {
              type: "object",
              properties: { answer: { type: "string", minLength: 1 } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        ]
        initialInput = "{}"
        repairedInput = '{"answer":"fixed"}'
      } else if (name === "ToolSearch") {
        request.tools = [
          {
            name,
            input_schema: {
              type: "object",
              properties: {
                query: { type: "string", minLength: 1 },
                max_results: { type: "integer", minimum: 1 },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
          {
            name: "WebFetch",
            defer_loading: true,
            input_schema: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
            },
          },
        ]
        initialInput = '{"max_results":1}'
        repairedInput = '{"query":"fixture","max_results":1}'
      }
      queue(
        nativeSSE(
          [
            {
              type: "tool_use",
              id: "initial_call",
              name,
              inputJson: initialInput,
            },
          ],
          "tool_use",
        ),
        nativeSSE(
          [
            {
              type: "thinking",
              thinking: "repair context",
              signature: "repair_signature",
            },
            {
              type: "tool_use",
              id: "repair_call",
              name,
              inputJson: repairedInput,
            },
          ],
          "tool_use",
        ),
      )

      const response = await send(request)
      expect(response.status).toBe(502)
      expect(await response.text()).toContain("signed native thinking")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    },
  )

  test("max_tokens partial Write is returned incomplete without repair", async () => {
    queue(
      nativeSSE(
        [
          {
            type: "tool_use",
            id: "call_partial",
            name: "Write",
            inputJson: '{"file_path":"fixture.ts"}',
          },
        ],
        "max_tokens",
        { output_tokens: 16_000 },
      ),
    )

    const response = await send()
    const result = await response.json()
    expect(response.status).toBe(200)
    expect(result).toMatchObject({
      stop_reason: "max_tokens",
      content: [
        {
          type: "tool_use",
          id: "call_partial",
          name: "Write",
          input: { file_path: "fixture.ts" },
        },
      ],
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const captured = JSON.stringify(logs.flatMap((log) => log.mock.calls))
    expect(captured).toContain('"endpoint":"messages"')
    expect(captured).toContain('"tokenValue":64000')
    expect(captured).toContain('"stream":true')
    expect(captured).toContain('"oneShot":true')
    expect(captured).toContain('"nativeRouting":"native_selected"')
  })

  test("context-window truncation maps to max_tokens and merges delta usage", async () => {
    queue(
      eventStreamResponse(textNativeEvents("model_context_window_exceeded")),
    )

    const response = await send()
    const result = await response.json()
    expect(response.status).toBe(200)
    expect(result).toMatchObject({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_input_tokens: 2,
      },
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("provider input from content_block_start is retained without deltas", async () => {
    const events = textNativeEvents()
    events.splice(
      1,
      3,
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "start_input",
          name: "Write",
          input: { file_path: "fixture.ts", content: "from start" },
        },
      },
      { type: "content_block_stop", index: 0 },
    )
    ;(events.at(-2) as { delta: { stop_reason: string } }).delta.stop_reason =
      "tool_use"
    queue(eventStreamResponse(events))

    const response = await send()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "start_input",
          name: "Write",
          input: { file_path: "fixture.ts", content: "from start" },
        },
      ],
    })
  })

  test("malformed completed native input fails, while truncation stays non-executable", async () => {
    queue(
      nativeSSE(
        [
          {
            type: "tool_use",
            id: "malformed_complete",
            name: "Write",
            inputJson: '{"file_path":',
          },
        ],
        "tool_use",
      ),
    )
    const complete = await send()
    expect(complete.status).toBe(502)
    expect(await complete.text()).toContain(
      "Native Messages upstream returned an invalid response.",
    )

    queue(
      nativeSSE(
        [
          {
            type: "tool_use",
            id: "malformed_partial",
            name: "Write",
            inputJson: '{"file_path":',
          },
        ],
        "max_tokens",
      ),
    )
    const partial = await send()
    const result = (await partial.json()) as {
      content: Array<{ type: string }>
      stop_reason: string
    }
    expect(partial.status).toBe(200)
    expect(result.stop_reason).toBe("max_tokens")
    expect(result.content.every((block) => block.type !== "tool_use")).toBe(
      true,
    )
    expect(JSON.stringify(result)).not.toContain('"input":{}')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("message_stop completes without waiting for physical EOF", async () => {
    let canceled = false
    queue(
      eventStreamResponse(textNativeEvents(), () => {
        canceled = true
      }),
    )

    const response = await send()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
    })
    expect(canceled).toBe(true)
  })

  test("message_stop ignores and cancels post-terminal tool actions", async () => {
    const events = textNativeEvents()
    events.push(
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "post_stop",
          name: "Write",
          input: { file_path: "fixture.ts", content: "must not execute" },
        },
      },
      { type: "content_block_stop", index: 1 },
    )
    queue(eventStreamResponse(events))

    const response = await send()
    const result = await response.json()
    expect(response.status).toBe(200)
    expect(JSON.stringify(result)).not.toContain("post_stop")
  })

  test("many small deltas do not impose a bytes-per-token wire cutoff", async () => {
    const events = textNativeEvents()
    events.splice(
      1,
      3,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      ...Array.from({ length: 22_000 }, () => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "a" },
      })),
      { type: "content_block_stop", index: 0 },
    )
    queue(eventStreamResponse(events))

    const response = await send()
    const result = (await response.json()) as {
      content: Array<{ text?: string }>
    }
    expect(response.status).toBe(200)
    expect(result.content[0]?.text).toHaveLength(22_000)
  })

  test("native refusal suppresses tool execution", async () => {
    queue(
      nativeSSE(
        [
          { type: "text", text: "Declined." },
          {
            type: "tool_use",
            id: "blocked_call",
            name: "Write",
            inputJson: '{"file_path":"fixture.ts","content":"blocked"}',
          },
        ],
        "refusal",
      ),
    )

    const response = await send()
    const result = (await response.json()) as {
      stop_reason: string
      content: Array<unknown>
    }
    expect(response.status).toBe(200)
    expect(result.stop_reason).toBe("refusal")
    expect(result.content).toEqual([{ type: "text", text: "Declined." }])
    expect(JSON.stringify(result)).not.toContain("blocked_call")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("streaming native refusal suppresses tool execution", async () => {
    queue(
      nativeSSE(
        [
          { type: "text", text: "Declined." },
          {
            type: "tool_use",
            id: "blocked_stream_call",
            name: "Write",
            inputJson: '{"file_path":"fixture.ts","content":"blocked"}',
          },
        ],
        "refusal",
      ),
    )

    const response = await send(payload(true))
    const output = await response.text()
    expect(response.status).toBe(200)
    expect(output).toContain('"stop_reason":"refusal"')
    expect(output).not.toContain("blocked_stream_call")
  })

  test.each([false, true])(
    "native refusal outranks malformed tool input (stream=%s)",
    async (stream) => {
      queue(
        nativeSSE(
          [
            { type: "text", text: "Declined." },
            {
              type: "tool_use",
              id: "malformed_refused_call",
              name: "Write",
              inputJson: '{"file_path":',
            },
          ],
          "refusal",
        ),
      )

      const response = await send(payload(stream))
      const output = await response.text()
      expect(response.status).toBe(200)
      expect(output).toContain('"stop_reason":"refusal"')
      expect(output).not.toContain("malformed_refused_call")
    },
  )

  test("native HTTP errors propagate without Chat fallback", async () => {
    queue(
      Response.json(
        {
          type: "error",
          error: { type: "permission_error", message: "denied" },
        },
        { status: 403 },
      ),
    )

    const response = await send()
    expect(response.status).toBe(403)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(urls[0]).toEndWith("/v1/messages")
  })

  test("an already-aborted one-shot never reaches upstream", () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    expect(
      createNativeMessagesCompletion(
        payload(),
        createToolNameMapFromAnthropicPayload(payload()),
        controller.signal,
      ),
    ).rejects.toThrow("cancelled")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each(["headers", "body"])(
    "20s correction deadline aborts native %s consumption",
    async (stage) => {
      const originalSetTimeout = globalThis.setTimeout
      let expire: (() => void) | undefined
      const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: (...args: Array<unknown>) => void,
        delay?: number,
        ...args: Array<unknown>
      ) => {
        if (delay === 20_000 && typeof callback === "function")
          expire = () => callback()
        return originalSetTimeout(callback, delay, ...args)
      }) as typeof setTimeout)
      let calls = 0
      let repairSignal: AbortSignal | undefined
      let bodyCanceled = false
      let started: (() => void) | undefined
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      fetchSpy.mockImplementation(
        Object.assign(
          (_url: string | URL | Request, init?: RequestInit) => {
            calls++
            if (calls === 1)
              return Promise.resolve(
                nativeSSE(
                  [
                    {
                      type: "tool_use",
                      id: "invalid_write",
                      name: "Write",
                      inputJson: '{"file_path":"fixture.ts"}',
                    },
                  ],
                  "tool_use",
                ),
              )
            repairSignal = init?.signal ?? undefined
            if (!repairSignal) throw new Error("Missing native repair signal")
            started?.()
            if (stage === "headers") {
              return new Promise<Response>((_resolve, reject) => {
                repairSignal?.addEventListener(
                  "abort",
                  () => reject(new Error("Native transport aborted")),
                  { once: true },
                )
              })
            }
            return Promise.resolve(
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        'event: ping\ndata: {"type":"ping"}\n\n',
                      ),
                    )
                  },
                  cancel() {
                    bodyCanceled = true
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      try {
        const pending = send()
        await ready
        if (!expire) throw new Error("Native repair deadline was not installed")
        expire()
        const response = await pending
        expect(response.status).toBe(502)
        expect(await response.text()).toContain("timed out after 20 seconds")
        expect(repairSignal?.aborted).toBe(true)
        if (stage === "body") expect(bodyCanceled).toBe(true)
      } finally {
        timeoutSpy.mockRestore()
      }
    },
  )

  test("local server web search orchestration keeps its internal passes native", async () => {
    state.webSearchProvider = "copilot"
    const request = payload(false)
    request.tools = [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 0,
      },
    ]
    queue(
      nativeSSE(
        [
          {
            type: "tool_use",
            id: "search_call",
            name: "__copilot_web_search",
            inputJson: '{"query":"current fixture"}',
          },
        ],
        "tool_use",
      ),
      nativeSSE([{ type: "text", text: "No search executed." }]),
    )

    const response = await send(request)
    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      content: Array<{ type: string; text?: string }>
    }
    expect(
      result.content.some((block) => block.type === "server_tool_use"),
    ).toBe(true)
    expect(
      result.content.some(
        (block) =>
          block.type === "text" && block.text === "No search executed.",
      ),
    ).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(urls.every((url) => url.endsWith("/v1/messages"))).toBe(true)
    expect(
      bodies.every(
        (body) =>
          Array.isArray(body.tools)
          && body.tools.every(
            (tool) =>
              typeof tool === "object"
              && tool !== null
              && "input_schema" in tool,
          ),
      ),
    ).toBe(true)
  })

  test("unrepresentable native history falls back before any native request", async () => {
    const request = payload()
    request.messages = [
      { role: "user", content: "Earlier search." },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "server_search",
            name: "web_search",
            input: { query: "fixture" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "server_search",
            content: [],
          },
        ],
      },
    ]
    queue(chatCompletion())

    const response = await send(request)
    expect(response.status).toBe(200)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toEndWith("/chat/completions")
  })
})
