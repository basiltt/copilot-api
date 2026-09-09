import type { Model } from "~/services/copilot/get-models"

/** Estimation metadata only; never added to the catalog or treated as entitlement. */
export function knownModelMetadata(id: string): Model | undefined {
  const canonical = id
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replaceAll(".", "-")
  if (canonical !== "claude-fable-5" && canonical !== "claude-fable-5-1")
    return undefined
  return {
    id,
    name: id,
    object: "model",
    vendor: "Anthropic",
    version: "fallback",
    model_picker_enabled: false,
    preview: false,
    capabilities: {
      family: canonical,
      tokenizer: "o200k_base",
      type: "chat",
      object: "model_capabilities",
      supports: { tool_calls: true },
      limits: {
        max_context_window_tokens: 1_000_000,
        max_output_tokens: 128_000,
      },
    },
  }
}

export function isFable51(id: string): boolean {
  return knownModelMetadata(id)?.capabilities.family === "claude-fable-5-1"
}
