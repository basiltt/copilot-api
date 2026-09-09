import { randomUUID } from "node:crypto"

import { HTTPError } from "~/lib/error"

import { WebSearchError, type WebSearchResult } from "./types"

const PREFIX = "copilot-search:v1:"
const MAX_ENTRIES = 2000
const MAX_BYTES = 8_000_000
const MAX_RECORD_BYTES = 64_000
const references = new Map<string, { result: WebSearchResult; bytes: number }>()
let retainedBytes = 0

/** Process-local opaque handles, not Anthropic ciphertext or encoded secrets. */
export function rememberSearchResult(result: WebSearchResult): string {
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8")
  if (bytes > MAX_RECORD_BYTES) {
    throw new WebSearchError(
      "Search source exceeds the 64KB replay record limit.",
    )
  }
  const reference = `${PREFIX}${randomUUID()}`
  while (references.size >= MAX_ENTRIES || retainedBytes + bytes > MAX_BYTES) {
    const oldest = references.keys().next().value
    if (!oldest) break
    retainedBytes -= references.get(oldest)?.bytes ?? 0
    references.delete(oldest)
  }
  references.set(reference, { result: { ...result }, bytes })
  retainedBytes += bytes
  return reference
}

export function resolveSearchReference(
  reference: string,
): WebSearchResult | undefined {
  if (!reference.startsWith(PREFIX)) return undefined
  const result = references.get(reference)
  if (!result) {
    const message =
      "Unknown or expired copilot-search:v1 replay reference. Search again; proxy references are process-local and are not Anthropic ciphertext."
    throw new HTTPError(
      message,
      Response.json(
        { type: "error", error: { type: "invalid_request_error", message } },
        { status: 400 },
      ),
    )
  }
  return { ...result.result }
}

export function searchReplayText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content)
  return JSON.stringify(
    content.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") return entry
      const item = entry as Record<string, unknown>
      if (typeof item.encrypted_content !== "string") return item
      const result = resolveSearchReference(item.encrypted_content)
      return result ?? item
    }),
  )
}
