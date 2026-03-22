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
export function stripImages(
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
