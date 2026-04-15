import type {
  AnthropicImageBlock,
  AnthropicMessagesPayload,
  AnthropicToolResultBlock,
} from "./anthropic-types"

const MIN_IMAGE_DIMENSION = 4

type InvalidImage = {
  mediaType: string
  width: number
  height: number
}

export function findInvalidEmbeddedImage(
  payload: AnthropicMessagesPayload,
): InvalidImage | undefined {
  for (const message of payload.messages) {
    if (message.role !== "user" || typeof message.content === "string") continue

    for (const block of message.content) {
      if (block.type === "image") {
        const invalid = getInvalidImageReason(block)
        if (invalid) return invalid
      }

      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const invalid = findInvalidImageInToolResult(block)
        if (invalid) return invalid
      }
    }
  }

  return undefined
}

function findInvalidImageInToolResult(
  block: AnthropicToolResultBlock,
): InvalidImage | undefined {
  if (typeof block.content === "string") return undefined

  for (const nested of block.content) {
    if (nested.type !== "image") continue
    const invalid = getInvalidImageReason(nested)
    if (invalid) return invalid
  }

  return undefined
}

function getInvalidImageReason(
  block: AnthropicImageBlock,
): InvalidImage | undefined {
  if (block.source.type !== "base64") return undefined // URL images: can't validate dimensions

  const size =
    block.source.media_type === "image/png" ?
      readPngSize(block.source.data)
    : undefined

  if (!size) return undefined
  if (size.width >= MIN_IMAGE_DIMENSION && size.height >= MIN_IMAGE_DIMENSION) {
    return undefined
  }

  return {
    mediaType: block.source.media_type,
    width: size.width,
    height: size.height,
  }
}
function readPngSize(
  base64: string,
): { width: number; height: number } | undefined {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(Buffer.from(base64, "base64"))
  } catch {
    return undefined
  }

  if (bytes.length < 24) return undefined

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!pngSignature.every((value, index) => bytes[index] === value)) {
    return undefined
  }

  const width =
    (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]
  const height =
    (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]

  return { width: width >>> 0, height: height >>> 0 }
}
