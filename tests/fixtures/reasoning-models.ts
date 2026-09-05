import type { Model, ModelsResponse } from "~/services/copilot/get-models"

export function makeReasoningModel(
  id: string,
  endpoints = ["/responses"],
  efforts?: Array<string>,
): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    preview: false,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      type: "chat",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      limits: {
        max_context_window_tokens: 1_000_000,
        max_prompt_tokens: 1_000_000,
        max_output_tokens: 128,
      },
      supports: efforts === undefined ? {} : { reasoning_effort: efforts },
    },
  }
}

export function reasoningCatalog(...models: Array<Model>): ModelsResponse {
  return { object: "list", data: models }
}
