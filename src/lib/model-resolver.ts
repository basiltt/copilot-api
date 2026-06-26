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
 * Anthropic publishes its models with a trailing `-YYYYMMDD` release-date
 * stamp (e.g. `claude-haiku-4-5-20251001`, `claude-sonnet-4-5-20250929`).
 * Copilot's catalog carries the undated form (`claude-haiku-4.5`), so the
 * stamp must be stripped before matching.
 *
 * The pattern is deliberately narrow — exactly eight consecutive trailing
 * digits — so it never touches Copilot's own dated ids, whose dates use
 * hyphen-separated components and therefore end in only two digits
 * (`gpt-4.1-2025-04-14`, `gpt-4o-2024-11-20`).
 */
const ANTHROPIC_DATE_SUFFIX = /-\d{8}$/

/**
 * Attempts to match a requested id against the catalog, first by exact id,
 * then by separator-insensitive {@link canonicalize} comparison.  Returns the
 * real catalog id on success, or `undefined` when nothing matches.
 */
function matchCatalogId(
  requestedId: string,
  models: ModelsResponse,
): string | undefined {
  // Exact match takes precedence over any fuzzy rewriting.
  if (models.data.some((m) => m.id === requestedId)) return requestedId

  // Fall back to canonical (separator-insensitive) matching.
  const target = canonicalize(requestedId)
  return models.data.find((m) => canonicalize(m.id) === target)?.id
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
 *  3. Date-stamped match — Anthropic's trailing `-YYYYMMDD` stamp is stripped
 *     and steps 1–2 are retried, so `claude-haiku-4-5-20251001` resolves to
 *     `claude-haiku-4.5`.  Runs last so a real exact/canonical match always
 *     wins before the stamp is removed.
 *
 * When nothing matches — or the catalog is unavailable — the original id is
 * returned unchanged so the upstream API produces its normal error.
 */
export function resolveModelId(
  requestedId: string,
  models: ModelsResponse | undefined,
): string {
  if (!requestedId || !models) return requestedId

  // 1 & 2. Exact, then canonical matching against the id as requested.
  const direct = matchCatalogId(requestedId, models)
  if (direct) return direct

  // 3. Strip Anthropic's trailing release-date stamp and retry.
  if (ANTHROPIC_DATE_SUFFIX.test(requestedId)) {
    const stripped = matchCatalogId(
      requestedId.replace(ANTHROPIC_DATE_SUFFIX, ""),
      models,
    )
    if (stripped) return stripped
  }

  return requestedId
}
