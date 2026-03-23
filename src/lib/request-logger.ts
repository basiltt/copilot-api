import type { Context, MiddlewareHandler } from "hono"

import { extractSessionId } from "~/lib/session-id"

// ─── Pure helpers (exported for testing) ─────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Extracts `model`, `stream`, and `sessionId` from the Hono request context.
 *
 * Uses `c.req.json()` instead of `c.req.raw.clone()` so that Hono's internal
 * body-cache is shared between the middleware and any subsequent handler that
 * also calls `c.req.json()`.  Reading the raw request body via `.clone()` in
 * production bypasses this cache and creates a `ReadableStream.tee()` on the
 * live TCP-socket-backed body, which can corrupt the stream that the handler
 * later tries to read — especially for large request bodies.
 *
 * `sessionId` is extracted from `metadata.user_id` (Anthropic protocol) via
 * {@link extractSessionId}, which parses the JSON-encoded value that Claude
 * Code sends and returns a stable 8-char hex hash.
 */
export async function extractBodyFields(
  c: Context,
): Promise<{ model?: string; stream?: boolean; sessionId?: string }> {
  try {
    const parsed = await c.req.json<Record<string, unknown>>()
    const metadata = parsed.metadata as Record<string, unknown> | undefined
    const sessionId = extractSessionId(
      typeof metadata?.user_id === "string" ? metadata.user_id : undefined,
    )
    return {
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      stream: typeof parsed.stream === "boolean" ? parsed.stream : undefined,
      sessionId,
    }
  } catch {
    return {}
  }
}

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const R = "\x1b[0m" // reset
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const BLUE = "\x1b[34m"
const CYAN = "\x1b[36m"

function colorStatus(status: number): string {
  const s = String(status)
  return status < 400 ? `${GREEN}${s}${R}` : `${RED}${s}${R}`
}

/**
 * Pads a string to the given width. ANSI escape codes are excluded from the
 * width calculation so coloured strings align correctly in the terminal.
 */
function pad(str: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = str.replaceAll(/\x1b\[[0-9;]*m/g, "")
  const diff = width - visible.length
  return diff > 0 ? str + " ".repeat(diff) : str
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now()
  const method = c.req.method
  const path = c.req.path

  // Extract body fields AFTER recording start time but BEFORE next() so the
  // duration still covers the full round-trip.  Because we use c.req.json()
  // (Hono's cached body reader) the result is shared with the handler —
  // no double-read, no stream tee.
  const { model, stream, sessionId } = await extractBodyFields(c)

  await next()

  const duration = Date.now() - start
  const status = c.res.status
  const ok = status < 400

  // Token count stored by handler via c.set("tokenCount", n)
  // Type is known via ContextVariableMap augmentation in src/lib/context-vars.ts
  const tokenCount = c.get("tokenCount")

  // On error: try to extract message from response body without consuming it
  let errorMsg = ""
  if (!ok) {
    try {
      const cloned = c.res.clone()
      const text = await cloned.text()
      const parsed = JSON.parse(text) as Record<string, unknown>
      const err = parsed.error as Record<string, unknown> | undefined
      errorMsg =
        typeof err?.message === "string" ? err.message : text.slice(0, 120)
    } catch {
      // ignore
    }
  }

  const now = new Date()
  const timeStr = pad(`${DIM}${now.toLocaleTimeString()}${R}`, 11)
  const prefix = ok ? `${CYAN}◀${R}` : `${RED}✕${R}`
  const methodStr = pad(`${DIM}${method}${R}`, 4)
  const pathStr = pad(`${CYAN}${path}${R}`, 27)
  const modelStr = pad(model ? `${YELLOW}${model}${R}` : "", 18)
  const sessionStr = pad(sessionId ? `${DIM}${sessionId}${R}` : "", 8)
  const streamStr = pad(stream === true ? `${BLUE}stream${R}` : "", 6)
  const statusStr = pad(colorStatus(status), 3)
  const durationStr = pad(formatDuration(duration), 6)
  const tokenStr = tokenCount !== undefined ? `${DIM}in:${tokenCount}${R}` : ""
  const errorStr = errorMsg ? `${RED}${errorMsg}${R}` : ""

  const line = [
    timeStr,
    prefix,
    methodStr,
    pathStr,
    modelStr,
    sessionStr,
    streamStr,
    statusStr,
    durationStr,
  ].join(" ")

  // Append optional trailing fields only when present (no trailing whitespace)
  const trailing = [tokenStr, errorStr].filter(Boolean).join(" ")

  // Use process.stdout directly to avoid consola adding its own timestamp
  process.stdout.write(`${trailing ? `${line} ${trailing}` : line}\n`)
}
