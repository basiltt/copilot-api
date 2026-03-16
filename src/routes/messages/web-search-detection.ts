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
 * tool defined (client is tool-capable). Sends a lightweight preflight
 * classification request to Copilot asking whether the last user message
 * requires real-time web data. Falls back to false on any failure.
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
  // Skip when the payload has no tools at all — if the client didn't
  // supply any tools, web search was not intended.
  if (!payload.tools || payload.tools.length === 0) {
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
          content: `Does this message require searching the web for current or real-time information?\nMessage: "${lastUserMessage}"`,
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
    const msg = payload.messages[i] as (typeof payload.messages)[number] | undefined
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

function getPreflightModel(requestModel: string): string {
  const models = state.models?.data ?? []
  const alternative = models.find((m) => m.id !== requestModel)
  return alternative?.id ?? requestModel
}
