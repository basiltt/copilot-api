import consola from "consola"

import { HTTPError } from "~/lib/error"
import { extractSessionId } from "~/lib/session-id"

import type {
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
} from "./anthropic-types"

/**
 * Thrown when the 413 retry cascade is exhausted (all images stripped,
 * request still too large). Signals the handler to return an
 * `invalid_request_error` that triggers Claude Code auto-compaction.
 */
export class CompactionNeededError extends Error {
  constructor() {
    super("Request too large even after stripping all images")
    this.name = "CompactionNeededError"
  }
}

/**
 * Tracks which sessions have had images proactively stripped.
 * Keyed by session ID (8-char hex hash from metadata.user_id).
 * When a session's images are stripped, its ID is added here.
 * When that session later sends a `/v1/messages` with zero images
 * (meaning compaction removed them), its ID is removed.
 *
 * This is per-session to prevent cross-session contamination:
 * Session A stripping images should NOT cause Session B to compact.
 */
const sessionsWithStrippedImages = new Set<string>()

/**
 * Returns true if the given session has had images stripped and
 * `count_tokens` should return an inflated value to trigger compaction.
 * Returns false for unknown sessions or sessions without the flag.
 */
export function hasStrippedImages(sessionId: string | undefined): boolean {
  if (!sessionId) return false
  return sessionsWithStrippedImages.has(sessionId)
}

/**
 * Extracts the session ID from an Anthropic payload's metadata.
 * Convenience wrapper so callers don't need to import extractSessionId separately.
 */
export function getSessionId(
  payload: AnthropicMessagesPayload,
): string | undefined {
  return extractSessionId(payload.metadata?.user_id)
}

/**
 * Called by the messages handler at the start of every `/v1/messages`
 * request.  If the incoming payload has no base64 images AND this
 * session previously had images stripped, compaction has succeeded
 * and the per-session flag is cleared so `count_tokens` stops
 * returning the inflated 200K value.
 */
export function updateImageFlag(payload: AnthropicMessagesPayload): void {
  const sessionId = getSessionId(payload)
  if (!sessionId || !sessionsWithStrippedImages.has(sessionId)) return

  const hasImages = payload.messages.some((msg) => {
    if (msg.role !== "user") return false
    if (typeof msg.content === "string") return false
    return msg.content.some((block) => {
      if (block.type === "image") return true
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        return block.content.some((nested) => nested.type === "image")
      }
      return false
    })
  })

  if (!hasImages) {
    consola.debug(
      `[${sessionId}] No images in conversation — compaction succeeded, clearing image flag.`,
    )
    sessionsWithStrippedImages.delete(sessionId)
  }
}

/** Reference to a single image block within its parent array. */
type ImageRef = {
  parent: Array<unknown>
  index: number
  base64Length: number
}

/** Collects image refs from a tool_result's nested content array. */
function collectToolResultImages(
  content: Array<
    AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock
  >,
  refs: Array<ImageRef>,
): void {
  for (let j = 0; j < content.length; j++) {
    const nested = content[j]
    if (nested.type === "image") {
      refs.push({
        parent: content as Array<unknown>,
        index: j,
        base64Length: nested.source.data.length,
      })
    }
  }
}

/**
 * Deep-clones the payload and replaces base64 image blocks with text
 * placeholders. When `keepLast` is true and 2+ images exist, the last
 * image (most recent in conversation order) is preserved.
 *
 * Returns the cloned (possibly mutated) payload, the count of images
 * actually replaced, and the total base64 character count removed.
 */
function stripImages(
  payload: AnthropicMessagesPayload,
  keepLast: boolean,
): {
  payload: AnthropicMessagesPayload
  strippedCount: number
  strippedBase64Chars: number
} {
  // Deep-clone to avoid mutating the original
  const cloned = structuredClone(payload)

  // Collect references to all base64 image blocks in conversation order.
  // Each entry holds the parent array and the index within that array so
  // we can replace the block in-place after deciding which ones to keep.
  const imageRefs: Array<ImageRef> = []

  for (const message of cloned.messages) {
    if (message.role !== "user") continue
    if (typeof message.content === "string") continue

    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i]

      // AnthropicImageBlock.source.type is always "base64" per current
      // type definitions, so narrowing on type === "image" is sufficient.
      if (block.type === "image") {
        imageRefs.push({
          parent: message.content as Array<unknown>,
          index: i,
          base64Length: block.source.data.length,
        })
      }

      // Walk nested tool_result content arrays
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        collectToolResultImages(block.content, imageRefs)
      }
    }
  }

  // Determine which images to strip
  const toStrip =
    keepLast && imageRefs.length > 1 ? imageRefs.slice(0, -1) : imageRefs

  const placeholder = {
    type: "text" as const,
    text: "[Image removed to reduce request size]",
  }

  let strippedBase64Chars = 0
  for (const ref of toStrip) {
    strippedBase64Chars += ref.base64Length
    ref.parent[ref.index] = placeholder
  }

  return { payload: cloned, strippedCount: toStrip.length, strippedBase64Chars }
}

/** Result of fetchWithImageStripping, includes stripped image metadata. */
export interface ImageStrippingResult<T> {
  response: T
  /** Total base64 characters removed from the payload before sending. */
  strippedBase64Chars: number
}

/**
 * Wraps a Copilot fetch function with reactive 413 retry logic.
 *
 * All images are sent as-is on the first attempt, letting Claude Code
 * manage its own context (including deciding when to compact and which
 * images to keep).  The proxy only intervenes when Copilot's HTTP body
 * size limit rejects the request with 413.
 *
 * Returns the response along with metadata about how many base64
 * characters were stripped, so the caller can inflate usage tokens.
 *
 * Cascade:
 *   1. Send payload unchanged (all images intact)
 *   2. On 413: strip older images (keep most recent), retry
 *   3. On 413: strip ALL images, retry
 *   4. On 413 with no images left: throw CompactionNeededError
 *
 * Non-413 HTTPErrors and non-HTTP errors propagate immediately.
 */
export async function fetchWithImageStripping<T>(
  fetchFn: (payload: AnthropicMessagesPayload) => Promise<T>,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<ImageStrippingResult<T>> {
  const sessionId = getSessionId(anthropicPayload)

  // Stage 1: Try with all images intact — let the model see everything.
  try {
    const response = await fetchFn(anthropicPayload)
    return { response, strippedBase64Chars: 0 }
  } catch (error) {
    if (!is413(error)) throw error
  }

  // Stage 2: Strip older images, keep the most recent one
  const stage2 = stripImages(anthropicPayload, true)
  if (stage2.strippedCount > 0) {
    consola.debug(
      `${sessionId ? `[${sessionId}] ` : ""}413 — stripped ${stage2.strippedCount} older image(s) (keeping last), retrying.`,
    )
    try {
      const response = await fetchFn(stage2.payload)
      return { response, strippedBase64Chars: stage2.strippedBase64Chars }
    } catch (error) {
      if (!is413(error)) throw error
    }
  }

  // Stage 3: Strip ALL images
  const stage3 = stripImages(anthropicPayload, false)
  if (stage3.strippedCount > 0) {
    if (sessionId) sessionsWithStrippedImages.add(sessionId)
    consola.warn(
      `${sessionId ? `[${sessionId}] ` : ""}413 — stripped all ${stage3.strippedCount} image(s), retrying.`,
    )
    try {
      const response = await fetchFn(stage3.payload)
      return { response, strippedBase64Chars: stage3.strippedBase64Chars }
    } catch (error) {
      if (!is413(error)) throw error
    }
  }

  // Stage 4: No images left, request is still too large — trigger compaction
  consola.warn(
    "Still too large (413) even without images, triggering auto-compaction",
  )
  throw new CompactionNeededError()
}

function is413(error: unknown): boolean {
  return error instanceof HTTPError && error.response.status === 413
}
