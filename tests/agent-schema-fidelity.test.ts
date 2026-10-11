import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"

import type { State } from "~/lib/state"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import { knownModelMetadata } from "~/lib/known-models"
import { state } from "~/lib/state"
import {
  createToolNameMapFromAnthropicPayload,
  toOpenAIToolName,
} from "~/routes/messages/tool-name-mapping"
import { server } from "~/server"

import { chatCompletionSSE } from "./helpers/chat-completion-sse"

type Transport =
  | "chat-json"
  | "chat-sse"
  | "buffered-sse"
  | "native-json"
  | "native-sse"

interface WireRequest {
  model: string
  tools: Array<{
    name?: string
    input_schema?: Record<string, unknown>
    function?: { name: string; parameters: Record<string, unknown> }
  }>
}

const transports: Array<Transport> = [
  "chat-json",
  "chat-sse",
  "buffered-sse",
  "native-json",
  "native-sse",
]
const dialects = [
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2020-12/schema",
]
// Captured from an isolated 2.1.295 safe-mode/plan-mode client; annotations removed.
const claudeCodeAgentSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    description: { type: "string" },
    prompt: { type: "string" },
    subagent_type: { type: "string" },
    model: { type: "string", enum: ["sonnet", "opus", "haiku", "fable"] },
    effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
    run_in_background: { type: "boolean" },
    isolation: { type: "string", enum: ["worktree", "remote"] },
  },
  required: ["description", "prompt"],
  additionalProperties: false,
}
let originalState: State
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let logs: Array<ReturnType<typeof spyOn<typeof consola, "debug">>>
let bodies: Array<WireRequest>

beforeEach(() => {
  originalState = { ...state }
  bodies = []
  const model = knownModelMetadata("claude-fable-5.1")
  if (!model) throw new Error("Missing test model")
  model.capabilities.supports.streaming = true
  Object.assign(state, {
    copilotToken: "test-token",
    vsCodeVersion: "1.0",
    accountType: "individual",
    models: { object: "list", data: [model] },
    nativeMessages: false,
    writeToolRecovery: false,
    toolSearchRecovery: false,
    structuredOutputRecovery: false,
    manualApprove: false,
    webSearchProvider: "off",
    rateLimitSeconds: undefined,
    burstCount: undefined,
    burstMinSpacingMs: 0,
  })
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected additional upstream request"),
  )
  fetchSpy.mockClear()
  logs = (["debug", "warn", "error", "info"] as const).map((method) =>
    spyOn(consola, method).mockImplementation(
      Object.assign(() => undefined, { raw: () => undefined }),
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
})

// These fields are synthetic caller declarations, not a hard-coded Agent API.
function schema(dialect = dialects[2], marker = "fixture") {
  return {
    $schema: dialect,
    $id: "urn:synthetic:agent-schema",
    type: "object",
    properties: {
      prompt: { type: "string" },
      scope: { $ref: "#/$defs/scope" },
      marker: { const: marker },
    },
    required: ["prompt", "scope", "marker"],
    additionalProperties: false,
    $defs: {
      scope: {
        type: "object",
        properties: {
          model: { enum: ["caller-selected"] },
          mode: { enum: ["read-only"] },
          permissions: { type: "array", items: { enum: ["read"] } },
        },
        required: ["model", "mode", "permissions"],
        additionalProperties: false,
      },
    },
  }
}

function input(marker = "fixture") {
  return {
    prompt: "Inspect this synthetic fixture without changing anything.",
    scope: {
      model: "caller-selected",
      mode: "read-only",
      permissions: ["read"],
    },
    marker,
  }
}

function payload(
  transport: Transport,
  inputSchema: Record<string, unknown> = schema(),
  name = "Agent",
): AnthropicMessagesPayload {
  state.nativeMessages = transport.startsWith("native")
  state.toolSearchRecovery = transport === "buffered-sse"
  const model = state.models?.data[0]
  if (!model) throw new Error("Missing test model")
  model.supported_endpoints =
    state.nativeMessages ? ["/v1/messages"] : ["/chat/completions"]
  return {
    model: model.id,
    max_tokens: 256,
    stream: transport.endsWith("sse"),
    messages: [{ role: "user", content: "Use the declared Agent contract." }],
    tools: [
      { name, input_schema: inputSchema },
      ...(state.toolSearchRecovery ?
        [{ name: "ToolSearch", input_schema: { type: "object" } }]
      : []),
    ],
  }
}

function completion(
  request: AnthropicMessagesPayload,
  candidate: Record<string, unknown>,
  name = "Agent",
): ChatCompletionResponse {
  const map = createToolNameMapFromAnthropicPayload(request)
  return {
    id: "chat_agent",
    object: "chat.completion",
    created: 1,
    model: request.model,
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        logprobs: null,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_agent",
              type: "function",
              function: {
                name: toOpenAIToolName(name, map),
                arguments: JSON.stringify(candidate),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  }
}

function nativeMessage(response: ChatCompletionResponse): AnthropicResponse {
  const choice = response.choices[0]
  return {
    id: "msg_agent",
    type: "message",
    role: "assistant",
    model: response.model,
    content: (choice.message.tool_calls ?? []).map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: JSON.parse(call.function.arguments) as Record<string, unknown>,
    })),
    stop_reason: choice.finish_reason === "length" ? "max_tokens" : "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 4 },
  }
}

function nativeSSE(response: ChatCompletionResponse): Response {
  const message = nativeMessage(response)
  const frames: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: { ...message, content: [], stop_reason: null },
    },
  ]
  for (const [index, block] of message.content.entries()) {
    if (block.type !== "tool_use") throw new Error("Expected fixture tool")
    frames.push(
      {
        type: "content_block_start",
        index,
        content_block: { ...block, input: {} },
      },
      {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      },
      { type: "content_block_stop", index },
    )
  }
  frames.push(
    {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: message.usage,
    },
    { type: "message_stop" },
  )
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function mockReply(transport: Transport, completion: ChatCompletionResponse) {
  let response: Response
  switch (transport) {
    case "native-json":
    case "native-sse": {
      response = nativeSSE(completion)
      break
    }
    default: {
      response =
        transport.endsWith("sse") ?
          chatCompletionSSE(completion)
        : Response.json(completion)
    }
  }
  fetchSpy.mockImplementationOnce(
    Object.assign(
      (_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("Expected JSON")
        bodies.push(JSON.parse(init.body) as WireRequest)
        return Promise.resolve(response)
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
}

async function send(request: AnthropicMessagesPayload) {
  return server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
}

function toolInputs(text: string, streaming: boolean): Array<unknown> {
  if (!streaming)
    return (JSON.parse(text) as AnthropicResponse).content
      .filter((block) => block.type === "tool_use")
      .map((block) => block.input)
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .filter((event) => event.type === "content_block_delta")
    .map((event) => event.delta as { partial_json?: string })
    .filter((delta) => delta.partial_json !== undefined)
    .map((delta) => JSON.parse(delta.partial_json ?? "") as unknown)
}

describe("Agent schema fidelity and atomic validation", () => {
  for (const transport of transports) {
    test(`${transport}: captured Claude Code 2.1.295 declaration and operation survive unchanged`, async () => {
      const request = payload(transport, claudeCodeAgentSchema)
      const operation = {
        description: "Inspect a synthetic fixture",
        prompt: "Inspect this synthetic fixture without changing anything.",
        subagent_type: "general-purpose",
        model: "fable",
        effort: "high",
        run_in_background: false,
        isolation: "worktree",
      }
      mockReply(transport, completion(request, operation))
      const response = await send(request)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(toolInputs(text, request.stream === true)).toEqual([operation])
      expect(text).toContain("call_agent")
      expect(text).toContain('"name":"Agent"')
      expect(bodies[0].model).toBe(request.model)
      const tool = bodies[0].tools[0]
      expect(tool.function?.parameters ?? tool.input_schema).toEqual(
        claudeCodeAgentSchema,
      )
      expect(request.tools?.[0].input_schema).toEqual(claudeCodeAgentSchema)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    for (const dialect of dialects) {
      test(`${transport}, ${dialect}: declaration and valid operation survive unchanged`, async () => {
        const declaration = schema(dialect)
        const request = payload(transport, declaration)
        const original = structuredClone(request)
        mockReply(transport, completion(request, input()))
        const response = await send(request)
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(toolInputs(text, request.stream === true)).toEqual([input()])
        expect(text).toContain("call_agent")
        expect(text).toContain('"name":"Agent"')
        expect(bodies[0].model).toBe(request.model)
        const tool = bodies[0].tools[0]
        expect(tool.function?.parameters ?? tool.input_schema).toEqual(
          declaration,
        )
        expect(request).toEqual(original)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      })
    }

    test(`${transport}: root additionalProperties failure releases no sibling action`, async () => {
      const request = payload(transport)
      request.tools?.push({
        name: "SafeSibling",
        input_schema: { type: "object", additionalProperties: false },
      })
      const result = completion(request, {
        ...input(),
        undeclared_fixture_option: "PRIVATE_SYNTHETIC_VALUE",
      })
      result.choices[0].message.tool_calls?.unshift({
        id: "call_sibling",
        type: "function",
        function: { name: "SafeSibling", arguments: "{}" },
      })
      mockReply(transport, result)
      const response = await send(request)
      expect(response.status).toBe(request.stream ? 200 : 502)
      const text = await response.text()
      expect(text).toContain("additionalProperties at $")
      expect(text).not.toContain('"type":"tool_use"')
      expect(text).not.toContain("undeclared_fixture_option")
      expect(text).not.toContain("PRIVATE_SYNTHETIC_VALUE")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    test(`${transport}: truncated Agent output remains incomplete without correction`, async () => {
      const request = payload(transport)
      const result = completion(request, {
        ...input(),
        incomplete_option: true,
      })
      result.choices[0].finish_reason = "length"
      mockReply(transport, result)
      const response = await send(request)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"stop_reason":"max_tokens"')
      expect(text).not.toContain('"stop_reason":"tool_use"')
      expect(text).not.toContain('"stop_reason":"end_turn"')
      expect(text).not.toContain('"type":"error"')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  }

  for (const transport of ["chat-json", "chat-sse"] as const) {
    test(`${transport}: refusal takes precedence over invalid Agent arguments`, async () => {
      const request = payload(transport)
      const result = completion(request, { ...input(), extra_option: true })
      result.choices[0].message.refusal = "Synthetic refusal fixture."
      result.choices[0].finish_reason = "content_filter"
      mockReply(transport, result)
      const response = await send(request)
      expect(response.status).toBe(200)
      const text = await response.text()
      if (request.stream) {
        expect(text).toContain('"type":"invalid_request_error"')
        expect(text).toContain("filtered by its safety policy")
      } else expect(text).toContain('"stop_reason":"refusal"')
      expect(text).not.toContain('"type":"tool_use"')
      expect(text).not.toContain('"type":"api_error"')
      expect(text).not.toContain("additionalProperties")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  }

  test("an aliased Agent name restores identity without changing its schema", async () => {
    const name = "synthetic.team/Agent"
    const request = payload("chat-json", schema(), name)
    mockReply("chat-json", completion(request, input(), name))
    const response = await send(request)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain(`"name":"${name}"`)
    expect(toolInputs(text, false)).toEqual([input()])
    expect(bodies[0].tools[0].function?.parameters).toEqual(schema())
  })

  test("concurrent Agent declarations with the same schema id stay request-local", async () => {
    const requests = ["first", "second"].map((marker) =>
      payload("chat-json", schema(dialects[2], marker)),
    )
    let release!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    let count = 0
    fetchSpy.mockImplementation(
      Object.assign(
        async (_url: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("Expected JSON")
          const body = JSON.parse(init.body) as WireRequest
          const properties = body.tools[0].function?.parameters.properties as
            | { marker: { const: string } }
            | undefined
          if (!properties) throw new Error("Expected synthetic schema")
          if (++count === 2) release()
          await bothStarted
          return Response.json(
            completion(requests[0], input(properties.marker.const)),
          )
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    const responses = await Promise.all(
      requests.map((request) => send(request)),
    )
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200)
      expect(toolInputs(await response.text(), false)).toEqual([
        input(index === 0 ? "first" : "second"),
      ])
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
