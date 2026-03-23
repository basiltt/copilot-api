import consola from "consola"

import { HTTPError } from "~/lib/error"

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
 * Set to true when images have been proactively stripped from a request.
 * Consumed (and reset) by `count_tokens` to force compaction when images
 * are accumulating in the conversation.
 */
export let imagesWereStripped = false

/** Resets the stripped-images flag after count_tokens has consumed it. */
export function resetImagesStrippedFlag(): void {
  imagesWereStripped = false
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
 * Wraps a Copilot fetch function with proactive image stripping and
 * progressive 413 retry logic.
 *
 * When the payload contains 2+ base64 images, older images are stripped
 * proactively (keeping the most recent) BEFORE the first request to
 * avoid a wasted 413 round-trip.  If a 413 still occurs, the cascade
 * continues by stripping all images, then triggering compaction.
 *
 * Returns the response along with metadata about how many base64
 * characters were stripped, so the caller can inflate usage tokens.
 *
 * Cascade:
 *   1. Proactively strip older images if 2+ exist, then send
 *   2. On 413: strip ALL images, retry
 *   3. On 413 with no images left: throw CompactionNeededError
 *
 * Non-413 HTTPErrors and non-HTTP errors propagate immediately.
 */
export async function fetchWithImageStripping<T>(
  fetchFn: (payload: AnthropicMessagesPayload) => Promise<T>,
  anthropicPayload: AnthropicMessagesPayload,
): Promise<ImageStrippingResult<T>> {
  // Proactive strip: if 2+ images exist, strip older ones before sending.
  // This avoids a guaranteed 413 round-trip when the conversation has
  // accumulated many screenshots over time.
  const preStrip = stripImages(anthropicPayload, true)
  const effectivePayload =
    preStrip.strippedCount > 0 ? preStrip.payload : anthropicPayload
  let totalStrippedChars = preStrip.strippedBase64Chars

  if (preStrip.strippedCount > 0) {
    imagesWereStripped = true
    consola.info(
      `Proactively stripped ${preStrip.strippedCount} older image(s) (keeping last) to avoid 413.`,
    )
  }

  // Stage 1: Try with (possibly pre-stripped) payload
  try {
    const response = await fetchFn(effectivePayload)
    return { response, strippedBase64Chars: totalStrippedChars }
  } catch (error) {
    if (!is413(error)) throw error
  }

  // Stage 2: Strip ALL images (from original payload)
  const stage2 = stripImages(anthropicPayload, false)
  totalStrippedChars = stage2.strippedBase64Chars
  if (stage2.strippedCount > 0) {
    consola.warn(
      `Request too large (413), retrying with all images stripped. Removed ${stage2.strippedCount} image(s).`,
    )
    try {
      const response = await fetchFn(stage2.payload)
      return { response, strippedBase64Chars: totalStrippedChars }
    } catch (error) {
      if (!is413(error)) throw error
    }
  }

  // Stage 3: No images left, request is still too large — trigger compaction
  consola.warn(
    "Still too large (413) even without images, triggering auto-compaction",
  )
  throw new CompactionNeededError()
}

function is413(error: unknown): boolean {
  return error instanceof HTTPError && error.response.status === 413
}
