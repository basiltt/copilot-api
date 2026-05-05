import { describe, test, expect, mock, beforeEach } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
    }
  },
)

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  fetchMock.mockClear()
})

describe("createChatCompletions transient upstream retries", () => {
  test("retries GitHub/Copilot 502 HTML errors and returns the later success", async () => {
    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          "<!DOCTYPE html><html><head><title>Unicorn! &middot; GitHub</title></head><body><p><strong>We had issues producing the response to your request.</strong></p></body></html>",
          {
            status: 502,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "retry-ok",
            object: "chat.completion",
            choices: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )

    const response = await createChatCompletions(payload)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((response as { id: string }).id).toBe("retry-ok")
  })
})
