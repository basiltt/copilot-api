import consola from "consola"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { HTTPError } from "~/lib/error"

// Descending order, independent of the order in the upstream catalog.
const REASONING_EFFORTS = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
]

// Exact models verified against Copilot. Do not infer a maximum from a GPT
// prefix: even adjacent generations can support different effort levels.
const VERIFIED_MAX_EFFORTS = new Map([
  ["gpt-6-astra", "max"],
  ["gpt-5.6-sol", "max"],
  ["gpt-5.6-terra", "max"],
  ["gpt-5.6-luna", "max"],
  ["gpt-5.5", "xhigh"],
  ["gpt-5.4", "xhigh"],
  ["gpt-5.4-2026-03-05", "xhigh"],
  ["gpt-5.4-mini", "xhigh"],
  ["gpt-5.3-codex", "xhigh"],
  ["gpt-5-mini", "high"],
  ["gpt-5-mini-2025-08-07", "high"],
])

type ReasoningEffortParam = "reasoning.effort" | "reasoning_effort"

function ultraError(
  model: string,
  param: ReasoningEffortParam,
  detail: string,
): HTTPError {
  const message = `Cannot resolve 'ultra' for model '${model}': ${detail}`
  return new HTTPError(
    message,
    Response.json(
      {
        error: {
          message,
          type: "invalid_request_error",
          param,
          code: "invalid_request_body",
        },
      },
      { status: 400 },
    ),
  )
}

function maximumReasoningEffort(
  model: string,
  models: ModelsResponse | undefined,
  param: ReasoningEffortParam,
): string {
  const capabilities = models?.data.find(
    (entry) => entry.id === model,
  )?.capabilities
  if (capabilities?.type && capabilities.type !== "chat") {
    throw ultraError(
      model,
      param,
      "the catalog does not identify a chat model.",
    )
  }

  const supports = capabilities?.supports
  const supportedEfforts: unknown = supports?.reasoning_effort
  if (supportedEfforts !== undefined) {
    if (
      !Array.isArray(supportedEfforts)
      || supportedEfforts.some(
        (effort: unknown) =>
          typeof effort !== "string" || !REASONING_EFFORTS.includes(effort),
      )
    ) {
      throw ultraError(
        model,
        param,
        "the catalog's reasoning efforts cannot be ranked safely. Specify an explicit supported effort.",
      )
    }

    const maximum = REASONING_EFFORTS.find(
      (effort) => effort !== "none" && supportedEfforts.includes(effort),
    )
    if (!maximum) {
      throw ultraError(
        model,
        param,
        "the catalog lists no active reasoning effort.",
      )
    }
    return maximum
  }

  const maximum = VERIFIED_MAX_EFFORTS.get(model.toLowerCase())
  if (!maximum) {
    throw ultraError(
      model,
      param,
      "no supported reasoning efforts or verified maximum are available. Specify an explicit supported effort.",
    )
  }
  return maximum
}

/** Expands only the client-side Ultra alias, before any upstream request. */
export function normalizeReasoningEffort<T>(
  effort: T,
  model: string,
  { models, param }: { models?: ModelsResponse; param: ReasoningEffortParam },
): T | string {
  if (typeof effort !== "string" || effort.toLowerCase() !== "ultra")
    return effort

  const maximum = maximumReasoningEffort(model, models, param)
  consola.debug(`[reasoning] ${model}: ${param} '${effort}' -> '${maximum}'`)
  return maximum
}
