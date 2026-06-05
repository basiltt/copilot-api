import type { ModelsResponse } from "~/services/copilot/get-models"

import { getModelContextWindow } from "~/services/copilot/get-models"

export interface ModelSelectionResult {
  model: string
  switched: boolean
  reason?: string
}

// These models support ~935k tokens (1M context) despite reporting lower limits.
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

export function selectModelForTokenCount(
  requestedModelId: string,
  models: ModelsResponse,
  estimatedTokens: number,
): ModelSelectionResult {
  const requestedModel = models.data.find((m) => m.id === requestedModelId)
  if (!requestedModel) {
    return { model: requestedModelId, switched: false }
  }

  if (MODELS_WITH_1M_CONTEXT.has(requestedModelId)) {
    return { model: requestedModelId, switched: false }
  }

  const contextWindow = getModelContextWindow(requestedModel)
  if (contextWindow === undefined) {
    return { model: requestedModelId, switched: false }
  }

  if (estimatedTokens <= contextWindow) {
    return { model: requestedModelId, switched: false }
  }

  // Find the model with the largest context window
  const largestModel = models.data.reduce<
    (typeof models.data)[number] | undefined
  >((best, m) => {
    const win = getModelContextWindow(m) ?? 0
    const bestWin = best ? (getModelContextWindow(best) ?? 0) : 0
    return win > bestWin ? m : best
  }, undefined)

  if (!largestModel || largestModel.id === requestedModelId) {
    return { model: requestedModelId, switched: false }
  }

  const largestWindow = getModelContextWindow(largestModel) ?? 0
  if (estimatedTokens > largestWindow) {
    return { model: requestedModelId, switched: false }
  }

  return {
    model: largestModel.id,
    switched: true,
    reason: `prompt ${estimatedTokens} tokens exceeds ${requestedModelId} limit ${contextWindow}, switching to ${largestModel.id} (${largestWindow})`,
  }
}
