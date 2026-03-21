import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

// ─── Pure helpers (exported for testing) ─────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Extracts `model` and `stream` from the Hono request context.
 *
 * Uses `c.req.json()` instead of `c.req.raw.clone()` so that Hono's internal
 * body-cache is shared between the middleware and any subsequent handler that
 * also calls `c.req.json()`.  Reading the raw request body via `.clone()` in
 * production bypasses this cache and creates a `ReadableStream.tee()` on the
 * live TCP-socket-backed body, which can corrupt the stream that the handler
 * later tries to read — especially for large request bodies.
 */
export async function extractBodyFields(
  c: Context,
): Promise<{ model?: string; stream?: boolean }> {
  try {
    const parsed = await c.req.json<Record<string, unknown>>()
    return {
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      stream: typeof parsed.stream === "boolean" ? parsed.stream : undefined,
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

// ─── Middleware ───────────────────────────────────────────────────────────────

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now()
  const method = c.req.method
  const path = c.req.path

  // Extract body fields AFTER recording start time but BEFORE next() so the
  // duration still covers the full round-trip.  Because we use c.req.json()
  // (Hono's cached body reader) the result is shared with the handler —
  // no double-read, no stream tee.
  const { model, stream } = await extractBodyFields(c)

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

  const prefix = ok ? `${CYAN}◀${R}` : `${RED}✕${R}`
  const methodStr = `${DIM}${method}${R}`
  const pathStr = `${CYAN}${path}${R}`
  const modelStr = model ? `${YELLOW}${model}${R}` : ""
  const streamStr = stream === true ? `${BLUE}stream${R}` : ""
  const tokenStr = tokenCount !== undefined ? `${DIM}in:${tokenCount}${R}` : ""
  const statusStr = colorStatus(status)
  const durationStr = formatDuration(duration)
  const errorStr = errorMsg ? `${RED}${errorMsg}${R}` : ""

  const parts = [
    prefix,
    methodStr,
    pathStr,
    modelStr,
    streamStr,
    tokenStr,
    statusStr,
    durationStr,
    errorStr,
  ].filter(Boolean)

  consola.log(parts.join("  "))
}
