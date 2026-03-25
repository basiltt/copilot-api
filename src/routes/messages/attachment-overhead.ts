import type {
  AnthropicDocumentBlock,
  AnthropicMessagesPayload,
} from "./anthropic-types"

// Approximation for text-like attachments where we only have raw characters.
// This intentionally rounds up a little so Claude Code compacts early rather
// than waiting until the proxy receives an oversized attachment payload.
const CHARS_PER_TOKEN = 4

// Anthropic's PDF docs show roughly 1k tokens for a small 3-page text-only
// PDF and much more for visually rich PDFs. We do not have extracted text or
// page counts here, so we use a size-based estimate with a conservative floor.
const MIN_PDF_TOKENS = 2_500
const PDF_BASE64_CHARS_PER_TOKEN = 80

// URL/file-backed documents still consume meaningful context once expanded by
// Claude Code, but we do not know their exact size at count-time.
const DEFAULT_REMOTE_DOCUMENT_TOKENS = 2_500

function estimateDocumentTokens(block: AnthropicDocumentBlock): number {
  const source = block.source

  if (source.type === "text") {
    return Math.max(1, Math.ceil(source.data.length / CHARS_PER_TOKEN))
  }

  if (source.type === "base64") {
    if (source.media_type === "application/pdf") {
      return Math.max(
        MIN_PDF_TOKENS,
        Math.ceil(source.data.length / PDF_BASE64_CHARS_PER_TOKEN),
      )
    }

    return Math.max(1, Math.ceil(source.data.length / CHARS_PER_TOKEN))
  }

  return DEFAULT_REMOTE_DOCUMENT_TOKENS
}

function getDocumentBlocksFromContent(
  content: NonNullable<AnthropicMessagesPayload["messages"][number]["content"]>,
): Array<AnthropicDocumentBlock> {
  if (typeof content === "string") return []

  const documents: Array<AnthropicDocumentBlock> = []

  for (const block of content) {
    if (block.type === "document") {
      documents.push(block)
      continue
    }

    if (block.type === "tool_result" && Array.isArray(block.content)) {
      for (const nested of block.content) {
        if (nested.type === "document") {
          documents.push(nested)
        }
      }
    }
  }

  return documents
}

export function estimateAdditionalAttachmentTokens(
  payload: AnthropicMessagesPayload,
): number {
  let tokens = 0

  for (const message of payload.messages) {
    if (message.role !== "user") continue

    for (const document of getDocumentBlocksFromContent(message.content)) {
      tokens += estimateDocumentTokens(document)
    }
  }

  return tokens
}
