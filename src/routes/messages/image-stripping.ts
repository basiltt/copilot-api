import consola from "consola"

import { HTTPError } from "~/lib/error"

import type { AnthropicMessagesPayload } from "./anthropic-types"

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

/** Reference to a single image block within its parent array. */
type ImageRef = { parent: Array<unknown>; index: number }

/** Collects image refs from a tool_result's nested content array. */
function collectToolResultImages(
  content: Array<{ type: string }>,
  refs: Array<ImageRef>,
): void {
  for (let j = 0; j < content.length; j++) {
    if (content[j].type === "image") {
      refs.push({ parent: content as Array<unknown>, index: j })
    }
  }
}

/**
 * Deep-clones the payload and replaces base64 image blocks with text
 * placeholders. When `keepLast` is true and 2+ images exist, the last
 * image (most recent in conversation order) is preserved.
 *
 * Returns the cloned (possibly mutated) payload and the count of images
 * actually replaced.
 */
function stripImages(
  payload: AnthropicMessagesPayload,
  keepLast: boolean,
): { payload: AnthropicMessagesPayload; strippedCount: number } {
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

  for (const ref of toStrip) {
    ref.parent[ref.index] = placeholder
  }

  return { payload: cloned, strippedCount: toStrip.length }
}

/**
 * Wraps a Copilot fetch function with progressive 413 retry logic.
 *
 * Cascade:
 *   1. Try original request
 *   2. On 413 with 2+ images: strip older images, keep last, retry
 *   3. On 413: strip ALL images, retry
 *   4. On 413 with no images left: throw CompactionNeededError
 *
 * Non-413 HTTPErrors and non-HTTP errors propagate immediately.
 */
export async function fetchWithImageStripping<T>(
  fetchFn: (payload: AnthropicMessagesPayload) => Promise<T>,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<T> {
  // Stage 1: Try original request
  try {
    return await fetchFn(anthropicPayload)
  } catch (error) {
    if (!is413(error)) throw error
  }

  // Stage 2: Strip older images, keep most recent
  const stage2 = stripImages(anthropicPayload, true)
  if (stage2.strippedCount > 0) {
    consola.warn(
      `Request too large (413), retrying with older images stripped (keeping last image). Removed ${stage2.strippedCount} image(s).`,
    )
    try {
      return await fetchFn(stage2.payload)
    } catch (error) {
      if (!is413(error)) throw error
    }
  }

  // Stage 3: Strip ALL images (always from original payload)
  const stage3 = stripImages(anthropicPayload, false)
  if (stage3.strippedCount > 0) {
    consola.warn(
      `Still too large (413), retrying with all images stripped. Removed ${stage3.strippedCount} image(s).`,
    )
    try {
      return await fetchFn(stage3.payload)
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
