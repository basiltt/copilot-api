import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { selectModelForTokenCount } from "~/lib/model-selector"
import { checkBurstLimit, checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  createResponsesCompletion,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { requiresResponsesApi } from "~/services/copilot/responses-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)
  await checkBurstLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Find the selected model
  let selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      c.set("tokenCount", tokenCount.input)
      consola.debug("Token count:", tokenCount)
      // Context-overflow guard: auto-switch to largest-context model if needed
      // state.models is non-null here — selectedModel was found from it
      if (state.models) {
        const result = selectModelForTokenCount(
          payload.model,
          state.models,
          tokenCount.input,
        )
        if (result.switched) {
          consola.warn(`Context overflow: ${result.reason}`)
          payload = { ...payload, model: result.model }
          // Update selectedModel so max_tokens defaulting below uses the switched model
          selectedModel =
            state.models.data.find((m) => m.id === result.model)
            ?? selectedModel
        }
      }
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  const usesResponsesApi =
    selectedModel !== undefined && requiresResponsesApi(selectedModel)

  const response =
    usesResponsesApi ?
      await createResponsesCompletion(payload)
    : await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

const isNonStreaming = (
  response:
    | Awaited<ReturnType<typeof createChatCompletions>>
    | Awaited<ReturnType<typeof createResponsesCompletion>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
