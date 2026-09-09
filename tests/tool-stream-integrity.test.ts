import { describe, expect, test } from "bun:test"

import type { AnthropicStreamState } from "~/routes/messages/anthropic-types"
import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import { HTTPError } from "~/lib/error"
import {
  flushDeferredFinish,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/stream-translation"
import {
  createResponsesStreamState,
  translateFromResponsesStream,
} from "~/services/copilot/responses-translation"

function responseFixture() {
  const options = {
    responseId: "response-test",
    model: "gpt-5.4",
    streamState: createResponsesStreamState(),
  }
  const feed = (event: Record<string, unknown>) =>
    translateFromResponsesStream(event, options)
  for (const index of [0, 1])
    feed({
      type: "response.output_item.added",
      output_index: index,
      item: {
        type: "function_call",
        id: `item${index}`,
        call_id: `call${index}`,
        name: "Workflow",
      },
    })
  return { options, feed }
}

function frame(
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finish_reason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: "chat",
    object: "chat.completion.chunk",
    created: 0,
    model: "claude-opus-5",
    choices: [{ index: 0, delta, finish_reason, logprobs: null }],
  }
}

describe("tool stream identity and terminal integrity", () => {
  test("conflicting known Responses identity signals fail instead of cross-wiring arguments", () => {
    const { feed } = responseFixture()
    expect(() =>
      feed({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "item1",
        delta: "{}",
      }),
    ).toThrow("conflicting")
  })

  test("unknown explicit Responses indices cannot reuse a different pending indexed call", () => {
    const { feed } = responseFixture()
    feed({
      type: "response.function_call_arguments.done",
      output_index: 0,
      arguments: "{}",
    })
    expect(() =>
      feed({
        type: "response.function_call_arguments.delta",
        output_index: 99,
        delta: "{}",
      }),
    ).toThrow("unknown indexed")
  })

  test("interleaved indexed Responses arguments stay associated with their calls", () => {
    const { feed } = responseFixture()
    feed({
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '{"runId":',
    })
    feed({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: '{"script":',
    })
    feed({
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '"one"}',
    })
    feed({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: '"two"}',
    })
    const output = feed({
      type: "response.completed",
      response: { status: "completed" },
    })
    expect(JSON.stringify(output)).toContain("one")
    expect(JSON.stringify(output)).toContain("two")
  })

  test.each(["error", "response.failed", "response.incomplete"])(
    "%s retains upstream policy code/message",
    async (type) => {
      const { feed } = responseFixture()
      const error = {
        code: "policy_denied",
        message: "This request is blocked by account policy.",
      }
      try {
        feed(
          type === "error" ? { type, ...error } : { type, response: { error } },
        )
        throw new Error("Expected an upstream error")
      } catch (caught) {
        expect(caught).toBeInstanceOf(HTTPError)
        if (!(caught instanceof HTTPError)) throw caught
        const body: unknown = await caught.response.json()
        expect(body).toMatchObject({ error })
      }
    },
  )

  test("repeated Chat terminal metadata commits tool calls only once and allows trailing usage", () => {
    const state: AnthropicStreamState = {
      messageStartSent: false,
      messageStopSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      hasEmittedText: false,
      thinkingBlockOpen: false,
      hasEmittedThinking: false,
      thinkingEnabled: false,
    }
    translateChunkToAnthropicEvents(
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call",
            type: "function",
            function: { name: "Workflow", arguments: '{"runId":"example"}' },
          },
        ],
      }),
      state,
    )
    const first = translateChunkToAnthropicEvents(
      frame({}, "tool_calls"),
      state,
    )
    const duplicate = translateChunkToAnthropicEvents(
      frame({}, "tool_calls"),
      state,
    )
    expect(
      first.filter((event) => event.type === "content_block_start"),
    ).toHaveLength(1)
    expect(duplicate).toHaveLength(0)
    expect(() =>
      translateChunkToAnthropicEvents(frame({ content: "late" }), state),
    ).toThrow("terminal")
    translateChunkToAnthropicEvents(
      {
        ...frame({}),
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
      state,
    )
    expect(
      flushDeferredFinish(state).some((event) => event.type === "message_stop"),
    ).toBe(true)
  })
})
