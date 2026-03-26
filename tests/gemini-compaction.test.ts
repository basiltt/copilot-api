/* eslint-disable max-lines-per-function */
import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { scaleTokensForModel } from "~/routes/messages/count-tokens-handler"
import {
  buildSyntheticCompactionResponse,
  looksLikeCompactionRequest,
  shouldUsePlainTextCompactionFallback,
} from "~/routes/messages/handler"

function makeModel(
  id: string,
  maxPromptTokens: number,
  maxContextWindowTokens: number,
): Model {
  return {
    id,
    object: "model",
    name: id,
    vendor: "google",
    version: "preview",
    model_picker_enabled: true,
    preview: true,
    capabilities: {
      family: "gemini",
      object: "capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {
        max_prompt_tokens: maxPromptTokens,
        max_context_window_tokens: maxContextWindowTokens,
        max_output_tokens: 64_000,
      },
      supports: {},
    },
  }
}

function makeResponse(
  content: string | null,
  finishReason: "stop" | "tool_calls" | "length",
  hasToolCalls: boolean = false,
): ChatCompletionResponse {
  return {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 0,
    model: "gemini-3.1-pro-preview",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(hasToolCalls && {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "TodoWrite",
                  arguments: "{}",
                },
              },
            ],
          }),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    },
  }
}

describe("Gemini compaction safeguards", () => {
  test("detects likely compaction requests from summary prompts", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      tools: [
        {
          name: "TodoWrite",
          description: "todo tool",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            "Please summarize the conversation into a compact summary for continuation.",
        },
      ],
    }

    expect(looksLikeCompactionRequest(payload)).toBe(true)
  })

  test("detects explicit requests to generate a continuation summary", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content:
            "Create a conversation continuation summary so this session can be resumed later.",
        },
      ],
    }

    expect(looksLikeCompactionRequest(payload)).toBe(true)
  })

  test("detects vscode compact command payloads", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content:
            "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
        },
      ],
    }

    expect(looksLikeCompactionRequest(payload)).toBe(true)
  })

  test("does not treat resumed post-compaction prompts as compaction requests", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context. "
            + "Resume directly from the latest state above and continue the task.",
        },
      ],
    }

    expect(looksLikeCompactionRequest(payload)).toBe(false)
  })

  test("ignores older summary text in history when the latest user turn is continue", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      messages: [
        {
          role: "assistant",
          content:
            "Conversation continuation summary:\n[user] Prior work summary\n\nContinue from the latest state above.",
        },
        {
          role: "user",
          content: "continue",
        },
      ],
    }

    expect(looksLikeCompactionRequest(payload)).toBe(false)
  })

  test("does not treat pasted continuation scaffold as a compaction request", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context. "
            + "The summary below covers the earlier portion of the conversation. "
            + "Conversation continuation summary: [assistant] prior work summary. "
            + "Resume directly from the latest state above and continue the task.",
        },
      ],
    }

    expect(looksLikeCompactionRequest(payload)).toBe(false)
  })

  test("uses plain-text fallback when compaction response tries to call tools", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      tools: [
        {
          name: "TodoWrite",
          description: "todo tool",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            "Create a conversation summary so this session can be continued from a previous conversation.",
        },
      ],
    }

    expect(
      shouldUsePlainTextCompactionFallback(
        payload,
        makeResponse(null, "tool_calls", true),
      ),
    ).toBe(true)
  })

  test("does not use the fallback for ordinary non-compaction requests", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      tools: [
        {
          name: "TodoWrite",
          description: "todo tool",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [{ role: "user", content: "Continue editing the toolbar." }],
    }

    expect(
      shouldUsePlainTextCompactionFallback(
        payload,
        makeResponse(null, "tool_calls", true),
      ),
    ).toBe(false)
  })

  test("scales Gemini token counts with extra safety margin", () => {
    const gemini = makeModel("gemini-3.1-pro-preview", 136_000, 200_000)
    expect(scaleTokensForModel(136_000, gemini)).toBeGreaterThan(200_000)
  })

  test("builds a synthetic plain-text summary when Gemini compaction still fails", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content:
            "Create a conversation summary so this session can be continued from a previous conversation.",
        },
        {
          role: "assistant",
          content:
            "We investigated the failing seed script and found the API healthcheck was flaky.",
        },
      ],
    }

    const response = buildSyntheticCompactionResponse(payload)
    expect(response.choices[0]?.message.content).toContain(
      "Conversation continuation summary:",
    )
    expect(response.choices[0]?.message.content).toContain(
      "failing seed script",
    )
    expect(response.choices[0]?.finish_reason).toBe("stop")
  })

  test("uses head and tail preservation when compaction fragments are long", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gemini-3.1-pro-preview",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content:
            "Create a conversation summary so this session can be continued from a previous conversation.",
        },
        {
          role: "assistant",
          content: `${"A".repeat(500)}MIDDLE${"Z".repeat(500)}`,
        },
      ],
    }

    const response = buildSyntheticCompactionResponse(payload)
    const content = response.choices[0]?.message.content ?? ""
    expect(content).toContain("AAAA")
    expect(content).toContain("ZZZZ")
    expect(content).toContain(" ... ")
  })

  test("applies extra proactive buffer for Gemini windows", () => {
    const gemini = makeModel("gemini-3.1-pro-preview", 136_000, 200_000)
    expect(scaleTokensForModel(128_000, gemini)).toBeGreaterThan(210_000)
  })
})
