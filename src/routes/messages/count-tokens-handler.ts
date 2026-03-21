import type { Context } from "hono"

import consola from "consola"

import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"

import { type AnthropicMessagesPayload, isTypedTool } from "./anthropic-types"
import { translateToOpenAI } from "./non-stream-translation"

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

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    const openAIPayload = translateToOpenAI(anthropicPayload)

    const selectedModel = state.models?.data.find(
      (model) => model.id === anthropicPayload.model,
    )

    if (!selectedModel) {
      consola.warn("Model not found, returning default token count")
      return c.json({
        input_tokens: 1,
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
    return c.json({
      input_tokens: 1,
    })
  }
}
