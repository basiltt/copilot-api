import consola from "consola"

import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { WEB_SEARCH_TOOL_NAMES } from "~/services/web-search/tool-definition"

import { isTypedTool, type AnthropicMessagesPayload } from "./anthropic-types"

/**
 * Returns true if this request should trigger a web search.
 *
 * Path 1: Zero-cost — checks if any typed tool in the request has a name
 * in WEB_SEARCH_TOOL_NAMES. Short-circuits to true without an API call.
 *
 * Path 2: Only fires when Path 1 is false AND the payload has at least one
 * custom tool whose name is in WEB_SEARCH_TOOL_NAMES (i.e., the client
 * declared a web-search-capable custom tool). Sends a lightweight preflight
 * classification request to Copilot asking whether the last user message
 * requires real-time web data. Falls back to false on any failure.
 *
 * Note: the preflight Copilot API call is not tracked by the outer rate
 * limiter — it is an internal fan-out. See interceptor.ts for the full
 * accounting of internal Copilot calls per request.
 */
export async function detectWebSearchIntent(
  payload: AnthropicMessagesPayload,
): Promise<boolean> {
  // Path 1: typed tool detection (free)
  const hasWebSearchTypedTool =
    payload.tools?.some(
      (tool) => isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name),
    ) ?? false

  if (hasWebSearchTypedTool) {
    return true
  }

  // Path 2: natural language preflight (costs one Copilot API call).
  // Only fires when the client has explicitly declared a custom tool with a
  // web-search name — this prevents the preflight from firing on every
  // Claude Code request (which always supplies Bash/editor tools but never
  // web search tools unless the user explicitly adds one).
  const hasWebSearchCustomTool =
    payload.tools?.some(
      (tool) => !isTypedTool(tool) && WEB_SEARCH_TOOL_NAMES.has(tool.name),
    ) ?? false

  if (!hasWebSearchCustomTool) {
    return false
  }

  const lastUserMessage = getLastUserMessageText(payload)
  if (!lastUserMessage) {
    return false
  }

  try {
    const preflightModel = getPreflightModel(payload.model)
    const response = (await createChatCompletions({
      model: preflightModel,
      stream: false,
      max_tokens: 5,
      messages: [
        {
          role: "system",
          content:
            'You are a classifier. Answer only "yes" or "no". No explanation.',
        },
        {
          role: "user",
          // Use XML delimiters so that quote characters in the user message
          // cannot break the classifier prompt (prompt injection mitigation).
          content: `Does this message require searching the web for current or real-time information?\n<message>${lastUserMessage}</message>`,
        },
      ],
    })) as ChatCompletionResponse

    const answer =
      response.choices[0]?.message.content?.trim().toLowerCase() ?? ""
    return answer === "yes"
  } catch (error) {
    consola.warn(
      "Web search preflight classification failed, treating as no-search-needed:",
      error,
    )
    return false
  }
}

/**
 * Returns a new payload with all typed web search tools removed.
 * Does not mutate the input.
 */
export function stripWebSearchTypedTools(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  return {
    ...payload,
    tools: payload.tools?.filter(
      (tool) => !isTypedTool(tool) || !WEB_SEARCH_TOOL_NAMES.has(tool.name),
    ),
  }
}

function getLastUserMessageText(payload: AnthropicMessagesPayload): string {
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const msg = payload.messages.at(i)
    if (msg?.role !== "user") continue
    if (typeof msg.content === "string") return msg.content
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join(" ")
    }
  }
  return ""
}

/**
 * Picks a small/cheap model for the single-token preflight classification.
 * Prefers models whose name contains "mini", "flash", "haiku", or "small"
 * as a heuristic for lower-cost models. Falls back to the request model if
 * no cheaper alternative is found.
 */
function getPreflightModel(requestModel: string): string {
  const models = state.models?.data ?? []
  const CHEAP_HINTS = ["mini", "flash", "haiku", "small"]
  const cheap = models.find((m) =>
    CHEAP_HINTS.some((hint) => m.id.toLowerCase().includes(hint)),
  )
  if (cheap) return cheap.id
  // Fall back: any model that isn't the request model (avoids same-model round-trip)
  const alternative = models.find((m) => m.id !== requestModel)
  return alternative?.id ?? requestModel
}
