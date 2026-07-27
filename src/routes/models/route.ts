import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { forwardError } from "~/lib/error"
import { resolveModelId } from "~/lib/model-resolver"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import {
  getModelContextWindow,
  getModelMaxOutput,
} from "~/services/copilot/get-models"

export const modelRoutes = new Hono()

// Copilot reports conservative max_prompt_tokens (e.g. 168k) but certain
// models actually accept up to ~935k tokens (1M context variant).
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

/**
 * Claude Desktop / Cowork groups the model picker by `anthropic_family_tier`
 * and *discards any model whose id does not begin with `claude` or
 * `anthropic`*.  Tagging the tier lets Anthropic-family models survive that
 * filter and land in the right picker group.
 *
 * Covers the 2026 lineup: opus / sonnet / haiku plus the newer `fable` and
 * `mythos` families.
 */
function anthropicFamilyTier(modelId: string): string | undefined {
  const id = modelId.toLowerCase()
  if (!id.startsWith("claude") && !id.startsWith("anthropic")) return undefined
  if (id.includes("opus")) return "opus"
  if (id.includes("sonnet")) return "sonnet"
  if (id.includes("haiku")) return "haiku"
  if (id.includes("fable")) return "fable"
  if (id.includes("mythos")) return "mythos"
  return undefined
}

function buildModelEntry(model: Model) {
  const rawInput = getModelContextWindow(model)
  const effectiveInput =
    MODELS_WITH_1M_CONTEXT.has(model.id) ? EFFECTIVE_1M_INPUT : rawInput
  const tier = anthropicFamilyTier(model.id)

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
    // Anthropic Models API exposes the window as `context_length`; Claude Code's
    // gateway discovery reads it to size the context budget for models it does
    // not recognize by name.
    context_length: effectiveInput,
    ...(tier ? { anthropic_family_tier: tier } : {}),
    ...(MODELS_WITH_1M_CONTEXT.has(model.id) ? { supports_1m: true } : {}),
  }
}

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models =
      state.models?.data.map((model) => buildModelEntry(model)) ?? []

    // Anthropic's Models API returns `first_id`/`last_id` alongside `has_more`.
    // Claude Desktop's discovery parses the Anthropic-native shape, so these
    // must be present (null on an empty list) for the picker to populate.
    return c.json({
      object: "list",
      data: models,
      has_more: false,
      first_id: models.at(0)?.id ?? null,
      last_id: models.at(-1)?.id ?? null,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

/**
 * `GET /v1/models/{model_id}` — the Anthropic Models API exposes a per-model
 * retrieval endpoint.  Clients probe it to validate a configured model id;
 * without it every probe 404s and the model can appear unavailable.
 *
 * Accepts the `[1m]` picker marker and Anthropic's `-YYYYMMDD` release stamp by
 * resolving through the same matcher used on the inference path.
 */
modelRoutes.get("/:modelId", async (c) => {
  try {
    if (!state.models) {
      await cacheModels()
    }

    const requested = c.req.param("modelId")
    const resolved = resolveModelId(requested, state.models)
    const model = state.models?.data.find((m) => m.id === resolved)

    if (!model) {
      return c.json(
        {
          type: "error",
          error: {
            type: "not_found_error",
            message: `model: ${requested}`,
          },
        },
        404,
      )
    }

    return c.json(buildModelEntry(model))
  } catch (error) {
    return await forwardError(c, error)
  }
})
