import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = null
    }
    consola.error("HTTP error:", errorJson ?? errorText)

    // Detect context-window-exceeded errors from upstream and return an
    // Anthropic-formatted "invalid_request_error" so Claude Code triggers
    // auto-compaction instead of just displaying a generic API error.
    // The raw Copilot error JSON uses a non-Anthropic format that Claude
    // Code doesn't recognize as retriable.
    const errorMessage = extractErrorMessage(errorJson, errorText)
    if (isContextWindowError(errorMessage)) {
      consola.debug(
        `Context window exceeded — extracted message: "${errorMessage}"`,
      )
      return c.json(buildAnthropicContextWindowErrorResponse(errorMessage), 400)
    }

    if (errorJson !== null && typeof errorJson === "object") {
      return c.json(
        errorJson as Record<string, unknown>,
        error.response.status as ContentfulStatusCode,
      )
    }
    return c.json(
      { error: { message: errorText, type: "error" } },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}

/** Extracts the error message from a parsed Copilot error response. */
function extractErrorMessage(errorJson: unknown, fallback: string): string {
  if (errorJson !== null && typeof errorJson === "object") {
    const obj = errorJson as Record<string, unknown>
    // Copilot format: { error: { message: "..." } }
    if (typeof obj.error === "object" && obj.error !== null) {
      const err = obj.error as Record<string, unknown>
      if (typeof err.message === "string") return err.message
    }
    // Direct message field
    if (typeof obj.message === "string") return obj.message
  }
  return fallback
}

/**
 * Detects whether an error message indicates the input exceeds the model's
 * context window.
 */
export function isContextWindowError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("exceeds the context window")
    || lower.includes("context_length_exceeded")
    || lower.includes("maximum context length")
    || lower.includes("input exceeds")
    // Copilot format: "prompt token count of X exceeds the limit of Y"
    // with code "model_max_prompt_tokens_exceeded"
    || lower.includes("exceeds the limit")
    || lower.includes("model_max_prompt_tokens_exceeded")
  )
}

/**
 * Builds a complete Anthropic-shaped error response for context-window errors.
 * Matches the real Anthropic API response shape exactly, including `request_id`,
 * so Claude Code recognizes it as a genuine `invalid_request_error` and triggers
 * reactive auto-compaction.
 */
export function buildAnthropicContextWindowErrorResponse(
  upstreamMessage: string,
  modelLimit?: number,
) {
  return {
    type: "error",
    request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    error: {
      type: "invalid_request_error",
      message: formatAnthropicContextWindowError(upstreamMessage, modelLimit),
    },
  }
}

/**
 * Converts a context-window error message into the exact format the real
 * Anthropic API uses: `"prompt is too long: {N} tokens > {M} maximum"`.
 *
 * Claude Code pattern-matches on this format to trigger reactive compaction.
 *
 * @param upstreamMessage - The raw error message from Copilot (used to extract token counts)
 * @param modelLimit - The model's actual max_prompt_tokens limit (used when regex extraction fails)
 */
export function formatAnthropicContextWindowError(
  upstreamMessage: string,
  modelLimit?: number,
): string {
  // Try to extract "prompt token count of X exceeds the limit of Y" from Copilot
  const match = upstreamMessage.match(
    /(\d[\d,]*)\s+exceeds\s+the\s+limit\s+of\s+(\d[\d,]*)/i,
  )
  if (match) {
    const actual = match[1].replaceAll(",", "")
    const limit = match[2].replaceAll(",", "")
    return `prompt is too long: ${actual} tokens > ${limit} maximum`
  }

  // Use the model's actual limit if available, otherwise fall back to defaults
  const limit = modelLimit ?? 128_000
  // Estimate actual tokens as ~1.5× the limit (we know it exceeded)
  const actual = Math.round(limit * 1.5)
  return `prompt is too long: ${actual} tokens > ${limit} maximum`
}
