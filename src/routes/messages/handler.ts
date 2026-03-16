import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { selectModelForTokenCount } from "~/lib/model-selector"
import { checkRateLimit } from "~/lib/rate-limit"
import { isWebSearchEnabled, state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  prepareWebSearchPayload,
  webSearchInterceptor,
} from "~/services/web-search/interceptor"
import { appendWebSearchInstruction } from "~/services/web-search/system-prompt"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

async function applyModelSwitch(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionsPayload> {
  if (!state.models) return payload
  try {
    const modelForCount = state.models.data.find((m) => m.id === payload.model)
    if (!modelForCount) return payload
    const { input: estimatedTokens } = await getTokenCount(payload, modelForCount)
    const result = selectModelForTokenCount(payload.model, state.models, estimatedTokens)
    if (result.switched) {
      consola.warn(`Context overflow: ${result.reason}`)
      return { ...payload, model: result.model }
    }
  } catch {
    consola.debug("Token count estimation failed, skipping model switch")
  }
  return payload
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  if (state.manualApprove) {
    await awaitApproval()
  }

  let response: Awaited<ReturnType<typeof createChatCompletions>>

  if (isWebSearchEnabled()) {
    const augmentedPayload: AnthropicMessagesPayload = {
      ...anthropicPayload,
      system: appendWebSearchInstruction(anthropicPayload.system),
    }
    const openAIPayload = await applyModelSwitch(prepareWebSearchPayload(translateToOpenAI(augmentedPayload)))
    consola.debug(
      "Translated OpenAI request payload (web search):",
      JSON.stringify(openAIPayload),
    )
    response = await webSearchInterceptor(openAIPayload)
  } else {
    const openAIPayload = await applyModelSwitch(translateToOpenAI(anthropicPayload))
    consola.debug(
      "Translated OpenAI request payload:",
      JSON.stringify(openAIPayload),
    )
    response = await createChatCompletions(openAIPayload)
  }

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
