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
    const contentType = error.response.headers.get("content-type")
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = null
    }
    const errorMessage = extractUpstreamErrorMessage(
      errorJson,
      errorText,
      contentType,
    )
    consola.error("HTTP error:", errorJson ?? errorMessage)

    // Detect context-window-exceeded errors from upstream and return an
    // Anthropic-formatted "invalid_request_error" so Claude Code triggers
    // auto-compaction instead of just displaying a generic API error.
    // The raw Copilot error JSON uses a non-Anthropic format that Claude
    // Code doesn't recognize as retriable.
    if (isContextWindowError(errorMessage, error.response.status)) {
      consola.debug(
        `Context window exceeded — extracted message: "${errorMessage}"`,
      )
      return sendAnthropicContextWindowError(c, errorMessage, { status: 400 })
    }

    if (errorJson !== null && typeof errorJson === "object") {
      return c.json(
        errorJson as Record<string, unknown>,
        error.response.status as ContentfulStatusCode,
      )
    }
    return c.json(
      { error: { message: errorMessage, type: "error" } },
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
export function extractUpstreamErrorMessage(
  errorJson: unknown,
  fallback: string,
  contentType?: string | null,
): string {
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

  return summarizeUpstreamErrorBody(fallback, contentType)
}

export function summarizeUpstreamErrorBody(
  body: string,
  contentType?: string | null,
): string {
  const trimmed = body.trim()
  if (!trimmed) return "Upstream request failed."
  if (!looksLikeHtml(trimmed, contentType)) return trimmed

  const title = extractHtmlText(trimmed, /<title[^>]*>([\s\S]*?)<\/title>/i)
  const headline = extractHtmlText(
    trimmed,
    /<strong[^>]*>([\s\S]*?)<\/strong>/i,
  )
  const paragraph = extractHtmlText(trimmed, /<p[^>]*>([\s\S]*?)<\/p>/i)

  const parts = [title, headline ?? paragraph].filter(Boolean)
  if (parts.length > 0) {
    return `Upstream returned an HTML error page: ${parts.join(" - ")}`
  }

  return "Upstream returned an HTML error page."
}

function looksLikeHtml(body: string, contentType?: string | null): boolean {
  return (
    contentType?.toLowerCase().includes("text/html") === true
    || /^\s*<!doctype html/i.test(body)
    || /^\s*<html[\s>]/i.test(body)
  )
}

function extractHtmlText(html: string, pattern: RegExp): string | undefined {
  const match = html.match(pattern)
  if (!match?.[1]) return undefined

  const decoded = match[1]
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&middot;", "·")
    .replaceAll("&mdash;", "-")
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim()

  return decoded.length > 0 ? decoded : undefined
}

/**
 * Detects whether an error message indicates the input exceeds the model's
 * context window.
 */
export function isContextWindowError(
  message: string,
  statusCode?: number,
): boolean {
  if (statusCode === 413) return true

  const lower = message.toLowerCase()
  return (
    lower.includes("exceeds the context window")
    || lower.includes("context_length_exceeded")
    || lower.includes("maximum context length")
    || lower.includes("input exceeds")
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
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  return {
    requestId,
    body: {
      type: "error",
      request_id: requestId,
      error: {
        type: "invalid_request_error",
        message: formatAnthropicContextWindowError(upstreamMessage, modelLimit),
      },
    },
  }
}

export function sendAnthropicContextWindowError(
  c: Context,
  upstreamMessage: string,
  options: {
    modelLimit?: number
    status?: ContentfulStatusCode
  } = {},
) {
  const { requestId, body } = buildAnthropicContextWindowErrorResponse(
    upstreamMessage,
    options.modelLimit,
  )
  c.header("request-id", requestId)
  return c.json(body, options.status ?? 400)
}

export function sendAnthropicInvalidRequestError(
  c: Context,
  message: string,
  status: ContentfulStatusCode = 400,
) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  c.header("request-id", requestId)
  return c.json(
    {
      type: "error",
      request_id: requestId,
      error: {
        type: "invalid_request_error",
        message,
      },
    },
    status,
  )
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
  const limit = modelLimit ?? 935_000
  // Estimate actual tokens as ~1.5× the limit (we know it exceeded)
  const actual = Math.round(limit * 1.5)
  return `prompt is too long: ${actual} tokens > ${limit} maximum`
}

// ─── Responses API (OpenAI/Codex) context-window errors ──────────────────────
//
// The OpenAI Codex CLI only recognizes a context-window overflow — and
// therefore only triggers automatic conversation compaction — when it parses a
// streamed `response.failed` SSE event whose `response.error.code` equals
// `context_length_exceeded`. This was verified against the Codex source:
//   - codex-rs/codex-api/src/sse/responses.rs → `is_context_window_error()`
//     matches strictly on `error.code == "context_length_exceeded"`, producing
//     `ApiError::ContextWindowExceeded`.
//   - codex-rs/codex-client/src/transport.rs → `stream()` rejects any non-2xx
//     HTTP status as `TransportError::Http` *before* the SSE parser runs, so a
//     plain HTTP 400/413 can never reach the detector. The signal MUST be a
//     200 OK stream carrying the `response.failed` event.
//   - `ApiError::ContextWindowExceeded` → `CodexErr::ContextWindowExceeded`
//     (api_bridge.rs) is what the turn loop reacts to by auto-compacting
//     (core/src/compact.rs, core/src/session/turn.rs).

/** OpenAI error `code` Codex pattern-matches to trigger auto-compaction. */
export const CONTEXT_LENGTH_EXCEEDED_CODE = "context_length_exceeded"

const DEFAULT_CONTEXT_WINDOW_MESSAGE =
  "Your input exceeds the context window of this model. "
  + "Please reduce the size of your input or start a new conversation and try again."

/**
 * Chooses the message to surface for a context-window error. Prefers a real,
 * informative upstream message (e.g. one containing genuine token counts) and
 * otherwise uses a generic message. Never fabricates token numbers.
 */
export function contextWindowErrorMessage(upstreamMessage?: string): string {
  const trimmed = upstreamMessage?.trim()
  if (
    trimmed
    && /exceeds the (?:limit|context)|context.?length|maximum context|too long|input exceeds/i.test(
      trimmed,
    )
  ) {
    return trimmed
  }
  return DEFAULT_CONTEXT_WINDOW_MESSAGE
}

/**
 * Builds the `response.failed` SSE event payload that the OpenAI Responses API
 * emits (over a 200 OK stream) when the prompt exceeds the context window.
 * Codex reads the JSON `type` and `response.error.code` fields from the event
 * `data`; the `code` is what drives compaction.
 */
export function buildResponsesContextWindowFailedEvent(
  upstreamMessage?: string,
): {
  type: "response.failed"
  response: Record<string, unknown>
} {
  const id = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  return {
    type: "response.failed",
    response: {
      id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      error: {
        code: CONTEXT_LENGTH_EXCEEDED_CODE,
        message: contextWindowErrorMessage(upstreamMessage),
      },
      usage: null,
      metadata: {},
    },
  }
}

/**
 * Builds the OpenAI-shaped JSON error body for a context-window overflow on a
 * non-streaming request (returned with HTTP 400). Mirrors the real OpenAI error
 * shape so OpenAI-compatible clients recognize the `code`.
 */
export function buildOpenAIContextWindowErrorBody(upstreamMessage?: string): {
  error: {
    message: string
    type: "invalid_request_error"
    param: null
    code: string
  }
} {
  return {
    error: {
      message: contextWindowErrorMessage(upstreamMessage),
      type: "invalid_request_error",
      param: null,
      code: CONTEXT_LENGTH_EXCEEDED_CODE,
    },
  }
}
