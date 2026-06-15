import type { ModelsResponse } from "~/services/copilot/get-models"

/**
 * Canonicalizes a model id for fuzzy matching by lowercasing and treating
 * `.` and `-` as interchangeable separators.  Copilot publishes Claude/Gemini/
 * GPT models with dotted version suffixes (e.g. `claude-opus-4.8`), but clients
 * frequently request the all-hyphen form (`claude-opus-4-8`).  Collapsing the
 * separator lets the two forms compare equal.
 *
 * `claude-opus-4.8` and `claude-opus-4-8` both canonicalize to `claude-opus-4-8`.
 */
function canonicalize(modelId: string): string {
  return modelId.toLowerCase().replaceAll(".", "-")
}

/**
 * Resolves a requested model id to an id that actually exists in Copilot's
 * model catalog.
 *
 * Resolution order:
 *  1. Exact match — returned verbatim.  This guarantees legitimately
 *     hyphenated ids (e.g. `gpt-4-0125-preview`, `gpt-4`) are never rewritten.
 *  2. Canonical match — the requested id is compared against each available
 *     model using {@link canonicalize}, so `claude-opus-4-8` resolves to the
 *     real `claude-opus-4.8`.  The first catalog entry that canonicalizes
 *     equal wins (catalog order, mirroring `Array.find`).
 *
 * When nothing matches — or the catalog is unavailable — the original id is
 * returned unchanged so the upstream API produces its normal error.
 */
export function resolveModelId(
  requestedId: string,
  models: ModelsResponse | undefined,
): string {
  if (!requestedId || !models) return requestedId

  // 1. Exact match takes precedence over any fuzzy rewriting.
  if (models.data.some((m) => m.id === requestedId)) return requestedId

  // 2. Fall back to canonical (separator-insensitive) matching.
  const target = canonicalize(requestedId)
  const match = models.data.find((m) => canonicalize(m.id) === target)
  return match ? match.id : requestedId
}
