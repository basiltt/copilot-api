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

function bodyError(message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, code: "invalid_request_body" } }),
    { status: 400, headers: { "content-type": "application/json" } },
  )
}

describe("deterministic invalid_request_body errors are NOT retried", () => {
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
