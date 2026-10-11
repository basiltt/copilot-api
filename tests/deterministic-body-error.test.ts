import { describe, test, expect, mock, beforeEach } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const fetchMock = mock((): Promise<unknown> => Promise.resolve())

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  fetchMock.mockReset()
})

function bodyError(message: string, status = 400): Response {
  return new Response(
    JSON.stringify({ error: { message, code: "invalid_request_body" } }),
    {
      status,
      headers: { "content-type": "application/json", "retry-after": "0" },
    },
  )
}

describe("deterministic invalid_request_body errors are NOT retried", () => {
  test.each([400, 408, 413, 429, 500, 502, 503, 504])(
    "explicit prompt overflow on HTTP %s is never a transient retry",
    async (status) => {
      const message = "prompt is too long: 1886265 tokens > 1000000 maximum"
      fetchMock.mockImplementation(() =>
        Promise.resolve(bodyError(message, status)),
      )

      const error = await createChatCompletions({
        messages: [{ role: "user", content: "synthetic overflow fixture" }],
        model: "claude-fable-5.1",
      }).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({
        message: "Failed to create chat completions",
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  test("policy codes take precedence even with an upstream server status", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          { error: { message: "Blocked by policy.", code: "cyber_policy" } },
          { status: 502, headers: { "retry-after": "0" } },
        ),
      ),
    )
    const error = await createChatCompletions({
      messages: [{ role: "user", content: "synthetic policy fixture" }],
      model: "gpt-test",
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("assistant prefill error fails immediately without burning retries", async () => {
    fetchMock.mockResolvedValue(
      bodyError(
        "This model does not support assistant message prefill. The conversation must end with a user message.",
      ),
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "assistant", content: "primed" }],
      model: "claude-opus-4.8",
    }

    let threw = false
    try {
      await createChatCompletions(payload)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // Deterministic shape error → exactly one upstream call, no exponential backoff.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("orphaned tool_result error fails immediately", async () => {
    fetchMock.mockResolvedValue(
      bodyError(
        "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.",
      ),
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "claude-opus-4.8",
    }

    let threw = false
    try {
      await createChatCompletions(payload)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("genuinely transient invalid_request_body errors are still retried", () => {
  test("a non-deterministic body error retries and can recover", async () => {
    fetchMock
      .mockResolvedValueOnce(
        bodyError("temporary backend validation hiccup, please retry"),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "ok", object: "chat.completion", choices: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }

    const response = await createChatCompletions(payload)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((response as { id: string }).id).toBe("ok")
  })
})
