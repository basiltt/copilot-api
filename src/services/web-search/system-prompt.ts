import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

const WEB_SEARCH_SYSTEM_INSTRUCTION =
  "\n\nYou have access to a web_search tool. Use it proactively whenever a question may benefit from current information, recent events, up-to-date facts, or anything that could have changed since your training cutoff. When in doubt, search."

/**
 * Appends the web-search usage instruction to the request's system prompt so
 * the model is nudged to call the injected web_search tool instead of relying
 * solely on training data.
 *
 * Handles all three forms of the Anthropic `system` field:
 *   - string → append instruction
 *   - Array<TextBlock> → append to the last text block (or add a new one)
 *   - undefined → return instruction as a plain string
 */
export function appendWebSearchInstruction(
  system: AnthropicMessagesPayload["system"],
): AnthropicMessagesPayload["system"] {
  if (typeof system === "string") {
    return system + WEB_SEARCH_SYSTEM_INSTRUCTION
  }

  if (Array.isArray(system)) {
    const lastTextIdx = system.length > 0 ? system.length - 1 : undefined

    if (lastTextIdx !== undefined) {
      return system.map((b, i) =>
        i === lastTextIdx ?
          { ...b, text: b.text + WEB_SEARCH_SYSTEM_INSTRUCTION }
        : b,
      )
    }

    // No text block found — add a new one
    return [
      ...system,
      { type: "text", text: WEB_SEARCH_SYSTEM_INSTRUCTION.trim() },
    ]
  }

  // No system prompt at all
  return WEB_SEARCH_SYSTEM_INSTRUCTION.trim()
}
