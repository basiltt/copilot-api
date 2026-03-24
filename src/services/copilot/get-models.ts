import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getModels = async () => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  supported_endpoints?: Array<string>
  policy?: {
    state: string
    terms: string
  }
}

/**
 * Safely extracts the effective input token limit from a model.
 *
 * Copilot's `/models` API exposes two relevant fields:
 * - `max_prompt_tokens` — the actual input ceiling Copilot enforces.
 * - `max_context_window_tokens` — the total window (prompt + output).
 *
 * We prefer `max_prompt_tokens` because that is the limit Copilot rejects
 * against, and it is what Claude Code needs as `max_input_tokens` to
 * trigger proactive compaction at the right time.
 *
 * Some models at runtime lack `capabilities` or `limits` entirely,
 * despite the TypeScript types marking them as required.
 */
export function getModelContextWindow(model: Model): number | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- some models lack capabilities at runtime
  const limits = model.capabilities?.limits
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard
  if (!limits) return undefined
  return limits.max_prompt_tokens ?? limits.max_context_window_tokens
}

/**
 * Safely extracts the max output tokens from a model.
 * Some models at runtime lack `capabilities` or `limits` entirely.
 */
export function getModelMaxOutput(model: Model): number | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- some models lack capabilities at runtime
  return model.capabilities?.limits?.max_output_tokens
}

/**
 * Safely extracts the total context window (prompt + output) from a model.
 * This is `max_context_window_tokens` — the full window size, NOT the
 * enforced input limit.  Use `getModelContextWindow()` for the input ceiling.
 */
export function getModelTotalContext(model: Model): number | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- some models lack capabilities at runtime
  return model.capabilities?.limits?.max_context_window_tokens
}
