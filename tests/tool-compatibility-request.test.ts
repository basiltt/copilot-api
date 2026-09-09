/* eslint-disable max-lines, max-lines-per-function */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { knownModelMetadata } from "~/lib/known-models"
import { resolveModelId } from "~/lib/model-resolver"
import { state } from "~/lib/state"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import { messageRoutes } from "~/routes/messages/route"
import {
  getModelContextWindow,
  getModelMaxOutput,
  getModelTotalContext,
} from "~/services/copilot/get-models"
import { translateToResponsesPayload } from "~/services/copilot/responses-translation"

const app = new Hono().route("/v1/messages", messageRoutes)
const originalState = { ...state }
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined

function urlText(url: string | URL | Request | undefined): string {
  return url instanceof Request ? url.url : String(url)
}

function upstreamBody(
  body: RequestInit["body"],
): ChatCompletionsPayload & { copilot_skills?: Array<string> } {
  if (typeof body !== "string")
    throw new Error("Expected serialized request body")
  return JSON.parse(body) as ChatCompletionsPayload & {
    copilot_skills?: Array<string>
  }
}

function searchName(body: ChatCompletionsPayload): string {
  const tool = body.tools?.find((entry) =>
    entry.function.name.startsWith("__copilot_web_search"),
  )
  if (!tool) throw new Error("Expected server search function")
  return tool.function.name
}

afterEach(() => {
  fetchSpy?.mockRestore()
  Object.assign(state, originalState)
})

const schema = {
  type: "object",
  properties: {
    script: { type: "string" },
    name: { type: "string" },
    scriptPath: { type: "string" },
    runId: { type: "string" },
    args: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
}

function request(stream = false): AnthropicMessagesPayload {
  return {
    model: "claude-opus-5",
    max_tokens: 1024,
    stream,
    messages: [{ role: "user", content: "Continue the example workflow." }],
    tools: [{ name: "Workflow", input_schema: schema, defer_loading: true }],
  }
}

function completion(args: string, name = "Workflow"): ChatCompletionResponse {
  return {
    id: "chat_example",
    object: "chat.completion",
    created: 1,
    model: "claude-opus-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_example",
              type: "function",
              function: { name, arguments: args },
            },
          ],
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }
}

function mockUpstream(response: Response, responsesOnly = false) {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0"
  state.braveApiKey = undefined
  state.tavilyApiKey = undefined
  state.webSearchProvider = undefined
  state.rateLimitSeconds = undefined
  state.burstCount = undefined
  state.burstMinSpacingMs = 0
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-opus-5",
        name: "claude-opus-5",
        object: "model",
        vendor: "test",
        version: "1",
        model_picker_enabled: true,
        preview: false,
        capabilities: {
          family: "test",
          tokenizer: "o200k_base",
          type: "chat",
          object: "model_capabilities",
          supports: {},
          limits: {
            max_context_window_tokens: 128000,
            max_prompt_tokens: 128000,
            max_output_tokens: 4096,
          },
        },
        supported_endpoints: [
          responsesOnly ? "/responses" : "/chat/completions",
        ],
      },
    ],
  }
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(() => Promise.resolve(response), {
      preconnect: globalThis.fetch.preconnect,
    }),
  )
}

async function send(payload: AnthropicMessagesPayload) {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

function nativeSearchStream(extra: Record<string, unknown> = {}) {
  return new Response(
    `data: ${JSON.stringify({
      copilot_references: [
        {
          type: "github.web-search",
          id: "source",
          data: {
            type: "web-search",
            query: "example",
            results: [
              {
                title: "Example reference",
                url: "https://example.com/docs",
                excerpt: "Documented source excerpt.",
              },
            ],
          },
        },
      ],
      ...extra,
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("native server search through Messages route", () => {
  test.each([false, true])(
    "search coexists with client calls (stream=%s) without fabricated client results",
    async (stream) => {
      mockUpstream(Response.json(completion("{}")))
      state.webSearchProvider = "copilot"
      state.githubToken = "test-github-login"
      let chatCalls = 0
      const urls: Array<string> = []
      fetchSpy?.mockImplementation(
        Object.assign(
          (url: string | URL | Request, init?: RequestInit) => {
            urls.push(urlText(url))
            if (urlText(url).endsWith("/skills"))
              return Promise.resolve(
                Response.json({ skills: [{ slug: "bing-search" }] }),
              )
            if (urlText(url).endsWith("/agents/chat")) {
              const body = upstreamBody(init?.body)
              expect(body.copilot_skills).toEqual(["bing-search"])
              expect(new Headers(init?.headers).get("authorization")).toBe(
                "Bearer test-github-login",
              )
              return Promise.resolve(nativeSearchStream())
            }
            chatCalls++
            const body = upstreamBody(init?.body)
            const internal = searchName(body)
            const response = completion('{"query":"example"}', internal)
            response.choices[0].message.tool_calls?.push({
              id: "client_call",
              type: "function",
              function: { name: "Workflow", arguments: '{"runId":"example"}' },
            })
            return Promise.resolve(Response.json(response))
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const payload = request(stream)
      payload.tools?.push({
        type: "web_search_20260318",
        name: "web_search",
        allowed_callers: ["direct"],
        max_uses: 2,
      })
      const response = await send(payload)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"type":"server_tool_use"')
      expect(text).toContain('"type":"web_search_tool_result"')
      expect(text).toContain("copilot-search:v1:")
      expect(text).toContain('"name":"Workflow"')
      expect(text).toContain('"stop_reason":"tool_use"')
      expect(text).toContain("web_search_result_location")
      expect(chatCalls).toBe(1)
      expect(urls.filter((url) => url.endsWith("/agents/chat"))).toHaveLength(1)
      expect(
        urls.every((url) => url.startsWith("https://api.githubcopilot.com/")),
      ).toBe(true)
    },
  )

  test("multiple calls enforce max_uses and synthesize only actual server results", async () => {
    mockUpstream(Response.json(completion("{}")))
    state.webSearchProvider = "copilot"
    state.githubToken = "test-github-login"
    let searches = 0
    let completions = 0
    fetchSpy?.mockImplementation(
      Object.assign(
        (url: string | URL | Request, init?: RequestInit) => {
          if (urlText(url).endsWith("/skills"))
            return Promise.resolve(
              Response.json({ skills: [{ slug: "bing-search" }] }),
            )
          if (urlText(url).endsWith("/agents/chat")) {
            searches++
            return Promise.resolve(nativeSearchStream())
          }
          const body = upstreamBody(init?.body)
          completions++
          if (completions === 1) {
            const internal = searchName(body)
            const result = completion('{"query":"one"}', internal)
            result.choices[0].message.tool_calls?.push({
              id: "call_two",
              type: "function",
              function: {
                name: internal,
                arguments: '{"query":"two"}',
              },
            })
            return Promise.resolve(Response.json(result))
          }
          expect(body.tool_choice).toBe("none")
          expect(
            body.messages.filter(
              (message: { role: string }) => message.role === "tool",
            ),
          ).toHaveLength(2)
          const result = completion("{}")
          result.choices[0].message = {
            role: "assistant",
            content: "Source-backed answer.",
          }
          result.choices[0].finish_reason = "stop"
          return Promise.resolve(Response.json(result))
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    const payload = request()
    payload.tools = [
      { type: "web_search_20250305", name: "web_search", max_uses: 1 },
    ]
    payload.tool_choice = { type: "tool", name: "web_search" }
    const result = await send(payload)
    expect(result.status).toBe(200)
    const body = (await result.json()) as AnthropicResponse
    expect(JSON.stringify(body)).toContain("max_uses_exceeded")
    expect(body.stop_reason).toBe("end_turn")
    expect(searches).toBe(1)
    expect(completions).toBe(2)
  })

  test.each(["missing-skill", "error-frame", "no-references", "confirmation"])(
    "%s is a visible search failure, never a silent empty success",
    async (scenario) => {
      mockUpstream(Response.json(completion("{}")))
      state.webSearchProvider = "copilot"
      state.githubToken = "test-github-login"
      let count = 0
      fetchSpy?.mockImplementation(
        Object.assign(
          (url: string | URL | Request) => {
            if (urlText(url).endsWith("/skills"))
              return Promise.resolve(
                Response.json({
                  skills:
                    scenario === "missing-skill" ?
                      []
                    : [{ slug: "bing-search" }],
                }),
              )
            if (urlText(url).endsWith("/agents/chat")) {
              if (scenario === "error-frame")
                return Promise.resolve(
                  nativeSearchStream({
                    copilot_references: [],
                    copilot_errors: [
                      {
                        type: "policy",
                        code: "policy_denied",
                        message: "Search blocked by policy.",
                        agent: "bing-search",
                      },
                    ],
                  }),
                )
              if (scenario === "confirmation")
                return Promise.resolve(
                  nativeSearchStream({
                    copilot_confirmation: { title: "Authorize" },
                  }),
                )
              return Promise.resolve(
                nativeSearchStream({
                  copilot_references: [],
                  choices: [
                    {
                      delta: {
                        content: "Fabricated prose URL https://example.net",
                      },
                    },
                  ],
                }),
              )
            }
            count++
            if (count > 1) {
              const result = completion("{}")
              result.choices[0].message = {
                role: "assistant",
                content: "Search unavailable.",
              }
              result.choices[0].finish_reason = "stop"
              return Promise.resolve(Response.json(result))
            }
            return Promise.resolve(
              Response.json(
                completion('{"query":"example"}', "__copilot_web_search"),
              ),
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const payload = request()
      payload.tools = [
        { type: "web_search_20250305", name: "web_search", max_uses: 1 },
      ]
      const result = await send(payload)
      const text = await result.text()
      if (scenario === "error-frame") {
        expect(result.status).toBe(502)
        expect(text).toContain("policy_denied")
      } else {
        expect(result.status).toBe(200)
        expect(text).toContain("web_search_tool_result_error")
        expect(text).toContain("unavailable")
      }
      expect(text).not.toContain('"type":"web_search_result"')
    },
  )

  test("none never initiates search, and latest sandbox defaults are rejected explicitly", async () => {
    mockUpstream(
      Response.json({
        ...completion("{}"),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "No search." },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
    )
    const payload = request()
    payload.tools = [{ type: "web_search_20250305", name: "web_search" }]
    payload.tool_choice = { type: "none" }
    expect((await send(payload)).status).toBe(200)
    expect(fetchSpy?.mock.calls).toHaveLength(1)
    state.webSearchProvider = "copilot"
    payload.tools = [{ type: "web_search_20260318", name: "web_search" }]
    const invalid = await send(payload)
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toContain("allowed_callers")
  })
})

describe("Fable context and alias compatibility", () => {
  test("Fable estimates typed tools and partial cached metadata without fetching or a 200K fallback", async () => {
    mockUpstream(Response.json(completion("{}")))
    const model = knownModelMetadata("claude-fable-5-1")
    if (!model) throw new Error("Expected Fable metadata")
    Reflect.deleteProperty(model.capabilities, "tokenizer")
    state.models = { object: "list", data: [model] }
    const response = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request(),
        model: "claude-fable-5.1",
        tools: [
          { type: "web_search_20250305", name: "web_search" },
          { type: "browser_toolset_20260801" },
          { type: "computer_toolset_20260801" },
        ],
      }),
    })
    const body = (await response.json()) as { input_tokens: number }
    expect(response.status).toBe(200)
    expect(body.input_tokens).toBeGreaterThan(0)
    expect(body.input_tokens).toBeLessThan(20_000)
    expect(fetchSpy?.mock.calls).toHaveLength(0)
  })
  test.each(["claude-fable-5", "claude-fable-5.1", "claude-fable-5-1"])(
    "%s has exact 1M metadata and estimates cache-miss tokens rather than forcing compaction",
    async (model) => {
      mockUpstream(Response.json(completion("{}")))
      const known = knownModelMetadata(model)
      expect(known).toBeDefined()
      if (!known) throw new Error("Expected known model")
      expect(getModelTotalContext(known)).toBe(1_000_000)
      expect(getModelMaxOutput(known)).toBe(128_000)
      state.models = { object: "list", data: [] }
      const response = await app.request("/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request(), model }),
      })

      const body = (await response.json()) as { input_tokens: number }
      expect(response.status).toBe(200)
      expect(body.input_tokens).toBeGreaterThan(0)
      expect(body.input_tokens).toBeLessThan(1000)
      expect(fetchSpy?.mock.calls).toHaveLength(0)
    },
  )

  describe("server search preserves ordinary request recovery", () => {
    test.each(["auto", "none"] as const)(
      "unused %s search declarations retain visible empty-turn fallback",
      async (mode) => {
        const empty = completion("{}")
        empty.choices[0].message = {
          role: "assistant",
          content: "",
        }
        empty.choices[0].finish_reason = "stop"
        mockUpstream(Response.json(empty))
        state.webSearchProvider = "copilot"
        const payload = request()
        payload.tools = [{ type: "web_search_20250305", name: "web_search" }]
        payload.tool_choice = { type: mode }
        const response = await send(payload)
        const body = (await response.json()) as AnthropicResponse
        expect(response.status).toBe(200)
        expect(
          body.content.some(
            (block) => block.type === "text" && block.text.length > 0,
          ),
        ).toBe(true)
        expect(fetchSpy?.mock.calls).toHaveLength(1)
      },
    )

    test("declared search retains structured output/title routing without a search call", async () => {
      const result = completion("{}")
      result.choices[0].message = {
        role: "assistant",
        content: '{"title":"Example title"}',
      }
      result.choices[0].finish_reason = "stop"
      mockUpstream(Response.json(result))
      state.webSearchProvider = "copilot"
      const payload = request()
      payload.tools = [{ type: "web_search_20250305", name: "web_search" }]
      payload.output_config = {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      }
      const response = await send(payload)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("Example title")
      expect(fetchSpy?.mock.calls).toHaveLength(1)
    })

    test("search preparation keeps context-window errors actionable", async () => {
      mockUpstream(
        Response.json(
          {
            error: {
              message: "prompt is too long: 130000 tokens > 128000 maximum",
              code: "context_length_exceeded",
            },
          },
          { status: 400 },
        ),
      )
      state.webSearchProvider = "copilot"
      const payload = request()
      payload.tools = [{ type: "web_search_20250305", name: "web_search" }]
      const response = await send(payload)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain("invalid_request_error")
      expect(fetchSpy?.mock.calls).toHaveLength(1)
    })

    test("async custom schemas fail before upstream; inert hosted options remain accepted", async () => {
      mockUpstream(Response.json(completion('{"runId":"example"}')))
      const payload = request()
      payload.tools = [
        {
          name: "Workflow",
          input_schema: { $async: true, type: "object" },
        },
      ]
      expect((await send(payload)).status).toBe(400)
      expect(fetchSpy?.mock.calls).toHaveLength(0)
      const valid = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request(),
          container: null,
          context_management: null,
          mcp_servers: [],
        }),
      })
      expect(valid.status).toBe(200)
    })

    test("duplicate expanded names fail without confusing namespace-shaped custom names", async () => {
      mockUpstream(Response.json(completion("{}")))
      const payload = request()
      payload.tools = [
        { name: "bash", input_schema: { type: "object" } },
        { name: "bash", type: "bash_20250124" },
      ]
      expect((await send(payload)).status).toBe(400)
      expect(fetchSpy?.mock.calls).toHaveLength(0)
    })
  })
  test("actual cached ID and limits win over fallback metadata", () => {
    const known = knownModelMetadata("claude-fable-5-1")
    if (!known) throw new Error("Expected known model")
    known.capabilities.limits = {
      max_prompt_tokens: 200_000,
      max_context_window_tokens: 250_000,
      max_output_tokens: 8192,
    }
    const catalog = { object: "list", data: [known] }
    expect(resolveModelId("claude-fable-5.1", catalog)).toBe("claude-fable-5-1")
    expect(getModelContextWindow(known)).toBe(200_000)
    expect(getModelTotalContext(known)).toBe(250_000)
    expect(getModelMaxOutput(known)).toBe(8192)
    expect(knownModelMetadata("claude-future-99")).toBeUndefined()
  })

  test("Fable5.1 rejects forced tools without changing model or calling upstream", async () => {
    mockUpstream(Response.json(completion("{}")))
    const payload = {
      ...request(),
      model: "claude-fable-5.1",
      tool_choice: { type: "any" as const },
    }
    const response = await send(payload)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("does not support forced tool use")
    expect(fetchSpy?.mock.calls).toHaveLength(0)
  })
})
function chatStream(parts: Array<Record<string, unknown>>) {
  return new Response(
    parts
      .map(
        (part) =>
          `data: ${JSON.stringify({
            id: "chat_example",
            object: "chat.completion.chunk",
            created: 1,
            model: "claude-opus-5",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: null,
                logprobs: null,
                ...part,
              },
            ],
          })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("tool compatibility through Messages HTTP route", () => {
  test("valid runId Workflow input survives nonstream request and response", async () => {
    const input = { runId: "run_example", args: { nested: [1, "two"] } }
    mockUpstream(Response.json(completion(JSON.stringify(input))))
    const result = await send(request())
    expect(result.status).toBe(200)
    const body = (await result.json()) as { content: Array<unknown> }
    expect(body.content[0]).toEqual({
      type: "tool_use",
      id: "call_example",
      name: "Workflow",
      input,
    })
    const upstream = upstreamBody(fetchSpy?.mock.calls[0][1]?.body)
    expect(upstream.tools?.[0].function.parameters.anyOf).toContainEqual({
      required: ["runId"],
    })
  })

  test.each(["", "{", "null", "[]", "42", "{}", '{"runId":8}'])(
    "rejects invalid upstream Workflow arguments %s without fabricating input",
    async (args) => {
      mockUpstream(Response.json(completion(args)))
      const result = await send(request())
      expect(result.status).toBe(502)
      const body = (await result.json()) as {
        type: string
        error: { type: string }
      }
      expect(body.type).toBe("error")
      expect(body.error.type).toBe("api_error")
      expect(body).not.toHaveProperty("content")
    },
  )

  test("reassembles split identity, repeated metadata and interleaved argument chunks", async () => {
    const parts = [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_0", function: { arguments: '{"run' } },
          ],
        },
      },
      {
        delta: {
          tool_calls: [
            {
              index: 1,
              id: "call_1",
              function: { name: "Workflow", arguments: '{"name":' },
            },
          ],
        },
      },
      { delta: { tool_calls: [{ index: 0, function: { name: "Work" } }] } },
      {
        delta: {
          tool_calls: [
            { index: 0, function: { name: "flow", arguments: 'Id":"run_0"}' } },
          ],
        },
      },
      {
        delta: {
          tool_calls: [
            {
              index: 1,
              id: "call_1",
              function: { name: "Workflow", arguments: '"example"}' },
            },
          ],
        },
      },
      { finish_reason: "tool_calls" },
    ]
    mockUpstream(chatStream(parts))
    const result = await send(request(true))
    const text = await result.text()
    expect(text).not.toContain("event: error")
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map(
        (line) =>
          JSON.parse(line.slice(6)) as {
            type: string
            index?: number
            content_block?: { type: string; id: string; name: string }
            delta?: { type: string; partial_json: string }
          },
      )
    const starts = events.filter(
      (event) => event.content_block?.type === "tool_use",
    )
    expect(starts.map((event) => event.content_block?.id)).toEqual([
      "call_0",
      "call_1",
    ])
    expect(
      starts.every((event) => event.content_block?.name === "Workflow"),
    ).toBe(true)
    const inputs = events
      .filter((event) => event.delta?.type === "input_json_delta")
      .map((event) => JSON.parse(event.delta?.partial_json ?? "") as unknown)
    expect(inputs).toEqual([{ runId: "run_0" }, { name: "example" }])
    for (const start of starts) {
      const relevant = events.filter((event) => event.index === start.index)
      expect(relevant.map((event) => event.type)).toEqual([
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
      ])
    }
  })

  test.each(["", "{}", '{"script":'])(
    "streaming malformed args %s never commits an executable tool",
    async (args) => {
      mockUpstream(
        chatStream([
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_0",
                  function: { name: "Workflow", arguments: args },
                },
              ],
            },
          },
          { finish_reason: "length" },
        ]),
      )
      const text = await (await send(request(true))).text()
      expect(text).toContain("event: error")
      expect(text).not.toContain('"type":"tool_use"')
      expect(text).not.toContain("event: message_stop")
    },
  )

  test("premature EOF does not commit even syntactically complete tool arguments", async () => {
    mockUpstream(
      chatStream([
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                function: {
                  name: "Workflow",
                  arguments: '{"runId":"example"}',
                },
              },
            ],
          },
        },
      ]),
    )
    const text = await (await send(request(true))).text()
    expect(text).toContain("event: error")
    expect(text).not.toContain('"type":"tool_use"')
  })

  test("Responses complete-only parallel tool arguments are wired to the HTTP route", async () => {
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "item_0",
          call_id: "call_0",
          name: "Workflow",
          arguments: "",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: "item_1",
          call_id: "call_1",
          name: "Workflow",
          arguments: '{"name":"example"}',
        },
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "opaque",
        arguments: '{"runId":"run_0"}',
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      },
    ]
    mockUpstream(
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
      true,
    )
    const text = await (await send(request(true))).text()
    expect(text).not.toContain("event: error")
    expect(text).toContain("run_0")
    expect(text).toContain("example")
    expect(text).toContain('"stop_reason":"tool_use"')
    expect(urlText(fetchSpy?.mock.calls[0][0])).toEndWith("/responses")
  })

  test("custom tools retain full schemas through Chat and Responses", () => {
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { selector: { type: "string", minLength: 1 } },
      properties: {
        a: { $ref: "#/$defs/selector" },
        b: { type: "integer" },
        extra: {},
      },
      oneOf: [{ required: ["a"] }, { required: ["b"] }],
      unevaluatedProperties: false,
    }
    for (const type of [undefined, null, "custom"] as const) {
      const payload = request()
      payload.tools = [
        { type, name: "mcp.plugin.search", input_schema: inputSchema },
      ]
      const chat = translateToOpenAI(payload)
      expect(chat.tools?.[0].function.parameters).toEqual(inputSchema)
      expect(translateToResponsesPayload(chat).tools?.[0].parameters).toEqual(
        inputSchema,
      )
    }
  })

  test("parameterless custom tools preserve valid explicit empty input", async () => {
    const payload = request()
    payload.tools = [
      {
        name: "no_args",
        input_schema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ]
    mockUpstream(Response.json(completion("{}", "no_args")))
    const result = await send(payload)
    expect(result.status).toBe(200)
    const body = (await result.json()) as { content: Array<{ input: unknown }> }
    expect(body.content[0].input).toEqual({})
  })

  test.each([false, true])(
    "toolset collisions and browser_state roundtrip (stream=%s)",
    async (stream) => {
      const payload = request(stream)
      payload.tools = [
        {
          name: "screenshot",
          input_schema: { type: "object", properties: {} },
        },
        { type: "browser_toolset_20260801" },
        { type: "computer_toolset_20260801" },
      ]
      const translated = translateToOpenAI(payload)
      const names = translated.tools?.map((tool) => tool.function.name) ?? []
      expect(new Set(names).size).toBe(names.length)
      expect(names).toContain("screenshot")
      expect(names).toContain("browser__screenshot")
      expect(names).toContain("computer__screenshot")
      const calls = [
        "screenshot",
        "browser__screenshot",
        "computer__screenshot",
      ].map((name, index) => ({
        id: `call_${index}`,
        type: "function" as const,
        function: { name, arguments: "{}" },
      }))
      if (stream) {
        mockUpstream(
          chatStream([
            {
              delta: {
                tool_calls: calls.map((call, index) => ({ ...call, index })),
              },
            },
            { finish_reason: "tool_calls" },
          ]),
        )
      } else {
        const result = completion("{}")
        result.choices[0].message.tool_calls = calls
        mockUpstream(Response.json(result))
      }
      const result = await send(payload)
      const text = await result.text()
      expect(result.status).toBe(200)
      expect(text).toContain('"toolset_name":"browser"')
      expect(text).toContain('"toolset_name":"computer"')
      expect(text).not.toContain('"name":"browser__screenshot"')
      payload.messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_browser",
              name: "list_tabs",
              toolset_name: "browser",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_browser",
              toolset_name: "browser",
              content: [
                {
                  type: "browser_state",
                  tabs: [
                    {
                      tab_id: "tab_1",
                      title: "Example",
                      url: "https://example.com",
                      active: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      )
      const history = translateToOpenAI(payload).messages
      expect(JSON.stringify(history)).toContain("browser__list_tabs")
      expect(JSON.stringify(history)).toContain("tab_1")
      expect(JSON.stringify(history)).toContain("https://example.com")
    },
  )

  test.each([
    "code_execution_20260521",
    "advisor_20260301",
    "web_fetch_20260318",
    "tool_search_tool_regex_20251119",
    "mcp_toolset",
  ])("hosted %s fails explicitly before upstream", async (type) => {
    mockUpstream(Response.json(completion("{}")))
    const payload = request()
    payload.tools = [{ type, name: "hosted" }]
    const result = await send(payload)
    expect(result.status).toBe(400)
    expect(await result.text()).toContain("not a supported client tool")
    expect(fetchSpy?.mock.calls).toHaveLength(0)
  })
})
