import type { ModelsResponse } from "~/services/copilot/get-models"

export interface ModelSelectionResult {
  model: string
  switched: boolean
  reason?: string
}

export function selectModelForTokenCount(
  requestedModelId: string,
  models: ModelsResponse,
  estimatedTokens: number,
): ModelSelectionResult {
  const requestedModel = models.data.find((m) => m.id === requestedModelId)
  if (!requestedModel) {
    return { model: requestedModelId, switched: false }
  }

  const contextWindow =
    requestedModel.capabilities.limits.max_context_window_tokens ??
    requestedModel.capabilities.limits.max_prompt_tokens

  if (contextWindow === undefined) {
    return { model: requestedModelId, switched: false }
  }

  if (estimatedTokens <= contextWindow) {
    return { model: requestedModelId, switched: false }
  }

  // Find the model with the largest context window
  const largestModel = models.data.reduce<(typeof models.data)[number] | undefined>(
    (best, m) => {
      const win =
        m.capabilities.limits.max_context_window_tokens ??
        m.capabilities.limits.max_prompt_tokens ??
        0
      const bestWin =
        (best?.capabilities.limits.max_context_window_tokens ??
        best?.capabilities.limits.max_prompt_tokens) ??
        0
      return win > bestWin ? m : best
    },
    undefined,
  )

  if (!largestModel || largestModel.id === requestedModelId) {
    return { model: requestedModelId, switched: false }
  }

  const largestWindow =
    largestModel.capabilities.limits.max_context_window_tokens ??
    largestModel.capabilities.limits.max_prompt_tokens ??
    0

  return {
    model: largestModel.id,
    switched: true,
    reason: `prompt ${estimatedTokens} tokens exceeds ${requestedModelId} context window ${contextWindow}, switching to ${largestModel.id} (${largestWindow})`,
  }
}
