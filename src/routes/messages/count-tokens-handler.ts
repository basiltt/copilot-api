import type { Context } from "hono"

import consola from "consola"

import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"

import {
  type AnthropicMessagesPayload,
  type AnthropicUserContentBlock,
  isTypedTool,
} from "./anthropic-types"
import { imagesWereStripped, resetImagesStrippedFlag } from "./image-stripping"
import { translateToOpenAI } from "./non-stream-translation"

// Base64 image data inflates the HTTP body far more than the tokenizer
// reflects.  The tokenizer encodes the data URL as text tokens (~3-4
// bytes per token), but Copilot's 413 limit is based on the raw HTTP
// body size.  To make Claude Code compact before 413 fires, we add a
// synthetic token overhead proportional to each image's base64 length.
//
// Empirical tuning: each base64 character contributes ~1 byte to the
// JSON body.  We approximate 1 "virtual token" per 2 base64 characters.
// This is intentionally aggressive — better to compact slightly early
// than to hit 413 on every request and retry.
const IMAGE_BYTES_PER_VIRTUAL_TOKEN = 2

// Token overhead for Anthropic-typed tools (per Anthropic pricing docs).
// Custom tools use the existing flat +346 for the entire tools array.
// Typed tools add per-tool overhead on top.
const ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD: Record<string, number> = {
  text_editor_20250728: 700,
  text_editor_20250429: 700,
  text_editor_20250124: 700,
  text_editor_20241022: 700,
  bash_20250124: 700,
  bash_20241022: 700,
  // computer_use and web_search: overhead included in beta pricing, not additive
}

function applyToolTokenOverhead(
  tokenCount: { input: number; output: number },
  payload: AnthropicMessagesPayload,
): void {
  if (!payload.tools) return

  if (payload.model.startsWith("claude")) {
    const hasCustomTools = payload.tools.some((t) => !isTypedTool(t))
    // Preserve existing flat +346 for the custom tools array (unchanged behavior)
    if (hasCustomTools) {
      tokenCount.input = tokenCount.input + 346
    }
    // Add per-typed-tool overhead for Anthropic-typed tools (new)
    for (const tool of payload.tools) {
      if (isTypedTool(tool)) {
        tokenCount.input =
          tokenCount.input
          + (ANTHROPIC_TYPED_TOOL_TOKEN_OVERHEAD[tool.type] ?? 0)
      }
    }
  } else if (payload.model.startsWith("grok")) {
    tokenCount.input = tokenCount.input + 480
  }
}

/** Collect base64 data lengths from a content block array. */
function collectImageDataLengths(
  blocks: Array<AnthropicUserContentBlock>,
): number {
  let totalLength = 0
  for (const block of blocks) {
    if (block.type === "image") {
      totalLength += block.source.data.length
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      for (const nested of block.content) {
        if (nested.type === "image") {
          totalLength += nested.source.data.length
        }
      }
    }
  }
  return totalLength
}

/**
 * Estimates additional token overhead for base64 images in the payload.
 *
 * The tokenizer counts base64 data URLs as text tokens, but massively
 * underestimates their contribution to HTTP body size (which is what
 * triggers Copilot's 413 limit).  This function walks the Anthropic
 * payload and adds virtual tokens proportional to the raw base64 data
 * length, so Claude Code compacts the conversation before 413 fires.
 */
function estimateImageTokenOverhead(payload: AnthropicMessagesPayload): number {
  let totalBase64Length = 0

  for (const message of payload.messages) {
    if (message.role !== "user") continue
    if (typeof message.content === "string") continue
    totalBase64Length += collectImageDataLengths(message.content)
  }

  if (totalBase64Length === 0) return 0

  const overhead = Math.ceil(totalBase64Length / IMAGE_BYTES_PER_VIRTUAL_TOKEN)
  consola.debug(
    `Image token overhead: ${overhead} virtual tokens (${totalBase64Length} base64 chars across payload)`,
  )
  return overhead
}

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    // If images were stripped from a recent messages request, force
    // compaction by returning a very high token count.  Claude Code
    // doesn't include image data in count_tokens payloads, so the
    // normal token calculation can't see them.  This flag is the only
    // way to signal "the conversation has images that need compaction."
    if (imagesWereStripped) {
      resetImagesStrippedFlag()
      consola.info(
        "Images were recently stripped — returning 200K tokens to trigger compaction",
      )
      return c.json({
        input_tokens: 200_000,
      })
    }

    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    const openAIPayload = translateToOpenAI(anthropicPayload)

    const selectedModel = state.models?.data.find(
      (model) => model.id === anthropicPayload.model,
    )

    if (!selectedModel) {
      consola.warn(
        `Model '${anthropicPayload.model}' not found in cached models, returning high token count to trigger compaction`,
      )
      return c.json({
        input_tokens: 200_000,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (anthropicBeta?.startsWith("claude-code")) {
        mcpToolExist = anthropicPayload.tools.some(
          (tool) => !isTypedTool(tool) && tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        applyToolTokenOverhead(tokenCount, anthropicPayload)
      }
    }

    // Add virtual token overhead for base64 images so Claude Code
    // compacts before the HTTP body exceeds Copilot's 413 size limit.
    tokenCount.input += estimateImageTokenOverhead(anthropicPayload)

    let finalTokenCount = tokenCount.input + tokenCount.output
    if (anthropicPayload.model.startsWith("claude")) {
      // Scale token count so Claude Code's context-window compaction kicks in
      // at the right time.  Copilot caps claude-opus at ~168K tokens while
      // Claude Code thinks the model supports ~200K.  A 1.2× multiplier maps
      // 168K actual → ~202K reported, triggering compaction before Copilot
      // rejects the request with model_max_prompt_tokens_exceeded.
      finalTokenCount = Math.round(finalTokenCount * 1.2)
    } else if (anthropicPayload.model.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    consola.debug("Token count:", finalTokenCount)

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    // Return a high token count on error so Claude Code's context-window
    // compaction kicks in.  Returning 1 would make Claude Code think the
    // context is nearly empty, so it would never compact and the next
    // completion request would be rejected by Copilot for exceeding the
    // prompt token limit.
    return c.json({
      input_tokens: 200_000,
    })
  }
}
