import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { resolveModelId } from "~/lib/model-resolver"
import { selectModelForTokenCount } from "~/lib/model-selector"
import { checkBurstLimit, checkRateLimit } from "~/lib/rate-limit"
import { normalizeReasoningEffort } from "~/lib/reasoning-effort"
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

/**
 * Returns the payload with its `model` normalized to a real Copilot model id
 * (e.g. `claude-opus-4-8` → `claude-opus-4.8`).  Returns the original payload
 * unchanged when the id already matches or no canonical match exists.
 */
function withResolvedModel(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const resolvedModel = resolveModelId(payload.model, state.models)
  if (resolvedModel === payload.model) return payload
  consola.debug(`[model-resolver] '${payload.model}' → '${resolvedModel}'`)
  return { ...payload, model: resolvedModel }
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Normalize the requested model id (e.g. `claude-opus-4-8` →
  // `claude-opus-4.8`) to a real Copilot model before lookup or forwarding.
  payload = withResolvedModel(payload)

  await checkBurstLimit(state, payload.model)

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

  // Resolve against the final target, after the existing context-overflow
  // selection, and outside its best-effort token-count error handler.
  payload.reasoning_effort = normalizeReasoningEffort(
    payload.reasoning_effort,
    payload.model,
    { models: state.models, param: "reasoning_effort" },
  )

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0
  const usesResponsesApi =
    (selectedModel !== undefined && requiresResponsesApi(selectedModel))
    || (hasTools && payload.model.startsWith("gpt-5"))

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
    let sentDone = false
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      // Forward the terminal `[DONE]` sentinel, then stop iterating rather than
      // waiting for the upstream HTTP connection to close (which can hang if
      // the Copilot API keeps it open).
      //
      // The sentinel MUST reach the client: the OpenAI Chat Completions
      // streaming contract terminates on `data: [DONE]`, and standard clients
      // (openai-python/-node, LangChain, Vercel AI SDK) block waiting for it.
      // Previously this broke *before* the write, swallowing the sentinel and
      // leaving those clients hanging until their own timeout fired.
      if (chunk.data === "[DONE]") {
        await stream.writeSSE({ data: "[DONE]" })
        sentDone = true
        break
      }
      await stream.writeSSE(chunk as SSEMessage)
    }

    // Upstream can end the body without ever emitting the sentinel (observed
    // when the final chunk is a usage-only frame).  Synthesize it so the client
    // always sees a well-formed terminator.
    if (!sentDone) {
      await stream.writeSSE({ data: "[DONE]" })
    }
  })
}

const isNonStreaming = (
  response:
    | Awaited<ReturnType<typeof createChatCompletions>>
    | Awaited<ReturnType<typeof createResponsesCompletion>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
