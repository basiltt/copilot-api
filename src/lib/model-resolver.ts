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
 * Claude Code and Claude Desktop append a `[1m]` marker to a model id when the
 * user selects the 1M-context row in the model picker (e.g.
 * `claude-sonnet-5[1m]`).  The marker is a *client-side* context-window
 * selector, not part of the upstream model name — Copilot's catalog has no
 * such entry and returns `400 model_not_supported` for it.
 *
 * This must be stripped before catalog matching.  It is trimmed first (ahead
 * of exact matching) because no real catalog id ever contains brackets.
 */
const CONTEXT_WINDOW_SUFFIX = /\[1m\]$/i

/** Removes the `[1m]` picker marker from a model id, if present. */
export function stripContextWindowSuffix(modelId: string): string {
  return modelId.replace(CONTEXT_WINDOW_SUFFIX, "")
}

/** Whether a requested model id carries the `[1m]` 1M-context marker. */
export function hasContextWindowSuffix(modelId: string): boolean {
  return CONTEXT_WINDOW_SUFFIX.test(modelId)
}

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
/**
 * Model ids Codex hardcodes for internal, non-user-facing turns.
 *
 * Codex sends these regardless of the `model` configured in `config.toml`, so
 * they reach a custom gateway verbatim and 400 with `model_not_supported`
 * (openai/codex#24879).  The affected features — sandbox auto-review, history
 * compaction — then fail silently for every third-party provider.
 *
 * Each maps to the *capability* the internal turn needs, resolved against the
 * live catalog in preference order.  These are cheap, mechanical turns, so a
 * small fast model is the right target.
 */
const CODEX_INTERNAL_MODEL_FALLBACKS: Record<string, Array<string>> = {
  "codex-auto-review": ["gpt-5.4-mini", "gpt-5-mini", "gpt-4o-mini"],
  "trajectory-compaction": ["gpt-5.4-mini", "gpt-5-mini", "gpt-4o-mini"],
}

/** Resolves a Codex-internal model alias against the catalog, if applicable. */
function resolveCodexInternalModel(
  requestedId: string,
  models: ModelsResponse,
): string | undefined {
  const candidates = CODEX_INTERNAL_MODEL_FALLBACKS[requestedId.toLowerCase()]
  if (!candidates) return undefined
  return candidates.find((c) => models.data.some((m) => m.id === c))
}

export function resolveModelId(
  requestedId: string,
  models: ModelsResponse | undefined,
): string {
  if (!requestedId) return requestedId
  // Strip `[1m]` even when the catalog is unavailable — the marker is never
  // valid upstream regardless of whether we can verify the base id.
  if (!models) return stripContextWindowSuffix(requestedId)

  // 0. Strip the client-side `[1m]` context-window marker.  Copilot's catalog
  //    never contains it, so it must go before any matching is attempted.
  const baseId = stripContextWindowSuffix(requestedId)

  // 1 & 2. Exact, then canonical matching against the id as requested.
  const direct = matchCatalogId(baseId, models)
  if (direct) return direct

  // 3. Strip Anthropic's trailing release-date stamp and retry.
  if (ANTHROPIC_DATE_SUFFIX.test(baseId)) {
    const stripped = matchCatalogId(
      baseId.replace(ANTHROPIC_DATE_SUFFIX, ""),
      models,
    )
    if (stripped) return stripped
  }

  // 4. Map Codex's hardcoded internal model ids onto a real catalog model.
  //    Runs last so a genuine catalog entry of the same name always wins.
  const internal = resolveCodexInternalModel(baseId, models)
  if (internal) return internal

  // Return the suffix-stripped id rather than the raw request: even when the
  // catalog lookup fails, forwarding `model[1m]` upstream is guaranteed to
  // 400, whereas the bare id may still be valid.
  return baseId
}
