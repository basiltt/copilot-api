import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test"

import type { State } from "~/lib/state"

import { state } from "~/lib/state"
import { server } from "~/server"

import {
  makeReasoningModel,
  reasoningCatalog,
} from "./fixtures/reasoning-models"

let fetchMock: Mock<typeof fetch>
let originalState: State

beforeEach(() => {
  originalState = { ...state }
  Object.assign(state, {
    copilotToken: "test-token",
    vsCodeVersion: "1.0.0",
    accountType: "individual",
    models: undefined,
    manualApprove: false,
    rateLimitSeconds: undefined,
    rateLimitWait: false,
    burstCount: undefined,
    burstWindowSeconds: undefined,
  })
  fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected upstream request"),
  )
})

afterEach(() => {
  fetchMock.mockRestore()
  Object.assign(state, originalState)
})

const ROUTES = [
  { path: "/v1/responses", upstream: "/responses" },
  { path: "/responses", upstream: "/chat/completions" },
  { path: "/v1/chat/completions", upstream: "/chat/completions" },
  { path: "/chat/completions", upstream: "/responses" },
]

function requestBody(
  path: string,
  model: string,
  { effort, stream = false }: { effort: unknown; stream?: boolean },
) {
  return path.endsWith("/responses") ?
      { model, input: "hello", reasoning: { effort, summary: "auto" }, stream }
    : {
        model,
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: effort,
        stream,
      }
}

async function post(path: string, body: unknown): Promise<Response> {
  return server.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function forwardedBody(): Record<string, unknown> {
  const body = fetchMock.mock.calls[0]?.[1]?.body
  if (typeof body !== "string") throw new Error("Expected a JSON upstream body")
  return JSON.parse(body) as Record<string, unknown>
}

function upstreamReply(
  endpoint: string,
  model: string,
  stream: boolean,
): Response {
  const response = {
    id: "resp_test",
    object: "response",
    model,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "OK" }],
      },
    ],
    usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
  }
  const completion = {
    id: "chatcmpl_test",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "OK" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  }
  if (!stream)
    return Response.json(endpoint === "/responses" ? response : completion)

  const chunks =
    endpoint === "/responses" ?
      [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
      ]
    : [
        `data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      ]
  return new Response(`${chunks.join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

for (const { path, upstream } of ROUTES) {
  describe(`${path} -> ${upstream} Ultra normalization`, () => {
    for (const stream of [false, true]) {
      test.each([
        { id: "gpt-6-astra", effort: "ultra", maximum: "max" },
        { id: "gpt-5.4", effort: "Ultra", maximum: "xhigh" },
        { id: "gpt-5-mini", effort: "ULTRA", maximum: "high" },
        {
          id: "future-reasoner",
          effort: "uLtRa",
          maximum: "xhigh",
          efforts: ["high", "xhigh", "low"],
        },
      ])(
        `normalizes before the only upstream call (stream=${stream}): %p`,
        async ({ id, effort, maximum, efforts }) => {
          state.models = reasoningCatalog(
            makeReasoningModel(id, [upstream], efforts),
          )
          fetchMock.mockResolvedValueOnce(upstreamReply(upstream, id, stream))
          const result = await post(
            path,
            requestBody(path, id, { effort, stream }),
          )
          expect(result.status).toBe(200)
          const output = await result.text()
          expect(output).toContain("OK")
          if (stream) expect(output).toContain("data: [DONE]")

          expect(fetchMock).toHaveBeenCalledTimes(1)
          expect(fetchMock.mock.calls[0][0]).toEndWith(upstream)
          const sent = forwardedBody()
          expect(sent.model).toBe(id)
          expect(sent.stream).toBe(stream)
          if (upstream === "/responses") {
            expect(sent.reasoning).toMatchObject({ effort: maximum })
          } else {
            expect(sent.reasoning_effort).toBe(maximum)
          }
        },
      )
    }

    test("honors catalog efforts before an exact-model default", async () => {
      const model = makeReasoningModel(
        "gpt-6-astra",
        [upstream],
        ["high", "low"],
      )
      state.models = reasoningCatalog(model)
      fetchMock.mockResolvedValueOnce(upstreamReply(upstream, model.id, false))
      const result = await post(
        path,
        requestBody(path, model.id, { effort: "ULTRA" }),
      )
      expect(result.status).toBe(200)
      await result.text()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const sent = forwardedBody()
      if (upstream === "/responses")
        expect(sent.reasoning).toMatchObject({ effort: "high" })
      else expect(sent.reasoning_effort).toBe("high")
    })

    test("keeps completely absent reasoning controls absent even without effort support", async () => {
      const model = makeReasoningModel("gpt-5-mini", [upstream], [])
      state.models = reasoningCatalog(model)
      fetchMock.mockResolvedValueOnce(upstreamReply(upstream, model.id, false))
      const body =
        path.endsWith("/responses") ?
          { model: model.id, input: "hello" }
        : { model: model.id, messages: [{ role: "user", content: "hello" }] }
      const result = await post(path, body)
      expect(result.status).toBe(200)
      await result.text()
      expect(forwardedBody()).not.toHaveProperty("reasoning")
      expect(forwardedBody()).not.toHaveProperty("reasoning_effort")
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test.each([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "High",
      undefined,
    ])("does not clamp or default ordinary effort %p", async (effort) => {
      const model = makeReasoningModel("gpt-5-mini", [upstream], [])
      state.models = reasoningCatalog(model)
      fetchMock.mockResolvedValueOnce(upstreamReply(upstream, model.id, false))
      const result = await post(path, requestBody(path, model.id, { effort }))
      expect(result.status).toBe(200)
      await result.text()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const sent = forwardedBody()
      if (upstream === "/responses") {
        const reasoning = effort === undefined ? undefined : { effort }
        expect(sent.reasoning).toEqual(
          path.endsWith("/responses") ? { effort, summary: "auto" } : reasoning,
        )
      } else {
        expect(sent.reasoning_effort).toBe(effort)
        if (effort === undefined)
          expect(sent).not.toHaveProperty("reasoning_effort")
      }
    })

    test.each([
      {
        stream: false,
        message:
          "Invalid value: 'max'. Supported values are: 'low', 'medium', 'high', and 'xhigh'.",
      },
      {
        stream: true,
        message:
          "Unsupported value: 'max' is not supported with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.",
      },
    ])(
      "does not retry or lower effort after rejection: %p",
      async ({ stream, message }) => {
        const model = makeReasoningModel("gpt-6-astra", [upstream])
        state.models = reasoningCatalog(model)
        const error = {
          error: {
            message,
            code: "invalid_request_body",
          },
        }
        fetchMock.mockResolvedValueOnce(Response.json(error, { status: 400 }))
        const result = await post(
          path,
          requestBody(path, model.id, { effort: "ultra", stream }),
        )
        expect(result.status).toBe(400)
        expect(await result.json()).toEqual(error)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const sent = forwardedBody()
        if (upstream === "/responses")
          expect(sent.reasoning).toMatchObject({ effort: "max" })
        else expect(sent.reasoning_effort).toBe("max")
      },
    )
  })
}

describe("Ultra route field preservation and capability errors", () => {
  test("preserves existing retries for enum errors unrelated to reasoning effort", async () => {
    const model = makeReasoningModel("legacy-model", ["/chat/completions"])
    state.models = reasoningCatalog(model)
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message:
                "Invalid value: 'auto'. Supported values are: 'none' and 'required'.",
              code: "invalid_request_body",
            },
          },
          { status: 400, headers: { "retry-after": "0" } },
        ),
      )
      .mockResolvedValueOnce(
        upstreamReply("/chat/completions", model.id, false),
      )
    const result = await post(
      "/v1/chat/completions",
      requestBody("/v1/chat/completions", model.id, { effort: undefined }),
    )
    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(forwardedBody()).not.toHaveProperty("reasoning_effort")
  })

  test("preserves native Responses fields, context controls, and model resolution", async () => {
    state.models = reasoningCatalog(makeReasoningModel("gpt-5.6-sol"))
    const reasoning = {
      effort: "Ultra",
      summary: "detailed",
      custom_control: { enabled: true },
    }
    const body = {
      model: "GPT-5-6-SOL",
      input: [{ role: "user", content: "original input" }],
      reasoning,
      include: ["reasoning.encrypted_content"],
      truncation: "disabled",
      max_output_tokens: 512,
      metadata: { test: "preserve" },
    }
    fetchMock.mockResolvedValueOnce(
      upstreamReply("/responses", "gpt-5.6-sol", false),
    )
    const result = await post("/responses", body)
    expect(result.status).toBe(200)
    expect(forwardedBody()).toEqual({
      ...body,
      model: "gpt-5.6-sol",
      reasoning: { ...reasoning, effort: "max" },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("preserves all reasoning fields when Responses must translate to Chat Completions", async () => {
    const model = makeReasoningModel(
      "custom-reasoner",
      ["/chat/completions"],
      ["low", "high"],
    )
    state.models = reasoningCatalog(model)
    const reasoning = { effort: "ULTRA", summary: "auto", custom_control: 23 }
    fetchMock.mockResolvedValueOnce(
      upstreamReply("/chat/completions", model.id, false),
    )
    const result = await post("/responses", {
      model: model.id,
      input: "hello",
      reasoning,
    })
    expect(result.status).toBe(200)
    expect(forwardedBody()).toMatchObject({
      model: model.id,
      reasoning: { ...reasoning, effort: "high" },
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hello" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("merges effective Chat Completions effort with other reasoning controls on the Responses path", async () => {
    const model = makeReasoningModel("gpt-6-astra")
    state.models = reasoningCatalog(model)
    const reasoning = { effort: "low", summary: "auto", custom_control: 23 }
    fetchMock.mockResolvedValueOnce(
      upstreamReply("/responses", model.id, false),
    )
    const result = await post("/v1/chat/completions", {
      model: model.id,
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "Ultra",
      reasoning,
    })
    expect(result.status).toBe(200)
    expect(forwardedBody().reasoning).toEqual({ ...reasoning, effort: "max" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("uses the final target's maximum after the existing context-overflow selection", async () => {
    const requested = makeReasoningModel("gpt-6-astra")
    requested.capabilities.limits.max_prompt_tokens = 1
    const target = makeReasoningModel("gpt-5-mini")
    state.models = reasoningCatalog(requested, target)
    fetchMock.mockResolvedValueOnce(
      upstreamReply("/responses", target.id, false),
    )
    const result = await post(
      "/v1/chat/completions",
      requestBody("/v1/chat/completions", requested.id, { effort: "ultra" }),
    )
    expect(result.status).toBe(200)
    expect(forwardedBody()).toMatchObject({
      model: target.id,
      reasoning: { effort: "high" },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  for (const path of ["/v1/responses", "/v1/chat/completions"]) {
    test.each([
      { id: "gpt-6-next" },
      { id: "gpt-4o" },
      { id: "gpt-6-astra", efforts: [] },
      { id: "gpt-6-astra", efforts: ["none"] },
      { id: "gpt-6-astra", efforts: ["high", "unknown"] },
      { id: "gpt-6-astra", type: "embeddings" },
    ])(
      `${path} returns a local typed error without starting a stream: %p`,
      async ({ id, efforts, type }) => {
        const model = makeReasoningModel(id, ["/responses"], efforts)
        if (type) model.capabilities.type = type
        state.models = reasoningCatalog(model)
        const result = await post(
          path,
          requestBody(path, id, { effort: "Ultra", stream: true }),
        )
        expect(result.status).toBe(400)
        expect(result.headers.get("content-type")).toContain("application/json")
        const body = (await result.json()) as { error: { message: string } }
        expect(body).toMatchObject({
          error: {
            type: "invalid_request_error",
            code: "invalid_request_body",
            param:
              path.endsWith("/responses") ? "reasoning.effort" : (
                "reasoning_effort"
              ),
          },
        })
        expect(body.error.message).toContain(id)
        expect(fetchMock).not.toHaveBeenCalled()
      },
    )
  }
})
