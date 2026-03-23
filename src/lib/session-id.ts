import { createHash } from "node:crypto"

/**
 * Extracts a compact session identifier from the Anthropic `metadata.user_id` field.
 *
 * Claude Code sets `metadata.user_id` to a JSON-encoded string like:
 *   `{"device_id":"...","session_id":"..."}`
 *
 * This function:
 * 1. Attempts to JSON.parse the string and extract `session_id` or `device_id`
 * 2. If parsing fails (plain UUID or arbitrary string), uses the raw value
 * 3. Returns the first 8 hex chars of a SHA-256 hash for a compact, stable identifier
 *
 * The hash ensures a consistent 8-char hex string regardless of input format,
 * and avoids leaking raw identifiers into logs.
 */
export function extractSessionId(
  userId: string | undefined,
): string | undefined {
  if (!userId || userId.length === 0) return undefined

  let key: string

  // Try to parse as JSON (Claude Code sends {"session_id":"...","device_id":"..."})
  if (userId.startsWith("{")) {
    try {
      const parsed = JSON.parse(userId) as Record<string, unknown>
      // Prefer session_id, fall back to device_id, then the full string
      key =
        (typeof parsed.session_id === "string" && parsed.session_id)
        || (typeof parsed.device_id === "string" && parsed.device_id)
        || userId
    } catch {
      key = userId
    }
  } else {
    key = userId
  }

  // Hash to get a stable, compact identifier
  return createHash("sha256").update(key).digest("hex").slice(0, 8)
}
