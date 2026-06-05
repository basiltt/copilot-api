import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import {
  getModelContextWindow,
  getModelMaxOutput,
} from "~/services/copilot/get-models"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    // Copilot reports conservative max_prompt_tokens (e.g. 168k) but certain
    // Claude models actually accept up to ~935k tokens (1M context variant).
    const MODELS_WITH_1M_CONTEXT = new Set([
      "claude-opus-4.6",
      "claude-opus-4.7",
      "claude-opus-4.8",
      "claude-sonnet-4.6",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gpt-5.4",
      "gpt-5.5",
    ])
    const EFFECTIVE_1M_INPUT = 935_000

    const models = state.models?.data.map((model) => {
      const rawInput = getModelContextWindow(model)
      const effectiveInput =
        MODELS_WITH_1M_CONTEXT.has(model.id) ? EFFECTIVE_1M_INPUT : rawInput
      return {
        id: model.id,
        object: "model",
        type: "model",
        created: 0,
        created_at: new Date(0).toISOString(),
        owned_by: model.vendor,
        display_name: model.name,
        max_input_tokens: effectiveInput,
        max_output_tokens: getModelMaxOutput(model),
      }
    })

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
