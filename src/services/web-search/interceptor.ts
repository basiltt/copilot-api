import consola from "consola"

import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
  type ChatCompletionResponse,
  type Message,
} from "~/services/copilot/create-chat-completions"

import { searchBrave } from "./brave"
import { WEB_SEARCH_FUNCTION_TOOL } from "./tool-definition"
import { BraveSearchError, type BraveSearchResult } from "./types"

// The name of the tool we inject — use the constant as the single source of truth
// so interceptor and handler stay in sync if the name ever changes.
const WEB_SEARCH_TOOL_NAME = WEB_SEARCH_FUNCTION_TOOL.function.name

interface SecondPassOptions {
  payload: ChatCompletionsPayload
  choice: ChatCompletionResponse["choices"][number]
  webSearchCallId: string
  toolResultContent: string
}

/**
 * Intercepts an OpenAI-format chat completions payload, executes any
 * web_search tool call made by the model, injects the results as tool
 * messages, and returns the final (second-pass) response.
 *
 * The caller is responsible for having already injected WEB_SEARCH_FUNCTION_TOOL
 * into the payload's tools array (via prepareWebSearchPayload).
 *
 * Rate limiting note: this function makes up to 2 internal Copilot API calls
 * (first pass + second pass) that are not tracked by the outer rate limiter.
 * The rate limiter applies only to inbound client requests, not to the internal
 * fan-out performed here.
 */
export async function webSearchInterceptor(
  payload: ChatCompletionsPayload,
): ReturnType<typeof createChatCompletions> {
  // First pass: always non-streaming so we can inspect finish_reason
  const firstPassPayload: ChatCompletionsPayload = { ...payload, stream: false }
  consola.debug("Web search first-pass payload:", JSON.stringify(firstPassPayload))

  const firstResponse = (await createChatCompletions(
    firstPassPayload,
  )) as ChatCompletionResponse
  consola.debug(
    "Web search first-pass response:",
    JSON.stringify(firstResponse).slice(-400),
  )

  const choice = firstResponse.choices.at(0)
  if (!choice || choice.finish_reason !== "tool_calls" || !choice.message.tool_calls) {
    return firstResponse
  }

  const webSearchCall = choice.message.tool_calls.find(
    (tc) => tc.function.name === WEB_SEARCH_TOOL_NAME,
  )
  if (!webSearchCall) {
    return firstResponse
  }

  // Parse query and perform search. toolResultContent is always assigned on
  // every branch before buildSecondPass is called.
  let toolResultContent: string
  try {
    const args = JSON.parse(webSearchCall.function.arguments) as { query: string }
    const query = args.query

    try {
      if (!state.braveApiKey) throw new BraveSearchError("BRAVE_API_KEY not set")
      const results = await searchBrave(query, state.braveApiKey)
      toolResultContent = formatSearchResults(query, results)
    } catch (error: unknown) {
      const reason = error instanceof BraveSearchError ? error.reason : String(error)
      consola.warn(`Web search failed: ${reason}`)
      toolResultContent = `Web search failed: ${reason}\nPlease answer based on your training data and let the user know that web search is currently unavailable.`
    }
  } catch {
    consola.warn("Web search: failed to parse tool call arguments")
    toolResultContent =
      "Web search failed: could not parse search query.\nPlease answer based on your training data and let the user know that web search is currently unavailable."
  }

  return buildSecondPass({ payload, choice, webSearchCallId: webSearchCall.id, toolResultContent })
}

/**
 * Prepares an OpenAI-format payload for the web search interceptor by
 * injecting WEB_SEARCH_FUNCTION_TOOL into the tools array. Owning tool
 * injection here keeps it co-located with the interceptor that depends on it.
 */
export function prepareWebSearchPayload(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  return {
    ...payload,
    tools: [...(payload.tools ?? []), WEB_SEARCH_FUNCTION_TOOL],
  }
}

function buildSecondPass({
  payload,
  choice,
  webSearchCallId,
  toolResultContent,
}: SecondPassOptions): ReturnType<typeof createChatCompletions> {
  const assistantMessage: Message = {
    role: "assistant",
    content: choice.message.content ?? null,
    tool_calls: choice.message.tool_calls,
  }

  // Inject a tool result for every tool_call in the assistant message.
  // Non-search tool calls get an empty stub so Copilot's second pass has
  // a complete result set (required — partial results cause rejection).
  const toolResultMessages: Array<Message> = (choice.message.tool_calls ?? []).map((tc) => ({
    role: "tool",
    tool_call_id: tc.id,
    content: tc.id === webSearchCallId ? toolResultContent : "",
  }))

  const secondPassMessages: Array<Message> = [
    ...payload.messages,
    assistantMessage,
    ...toolResultMessages,
  ]

  // Second pass: use original stream flag.
  // Set tool_choice: "none" to prevent the model from invoking web_search again
  // in the synthesis pass — a second tool call would produce finish_reason:
  // "tool_calls" that the Anthropic client has no way to resolve (it never knew
  // about the internal web_search call).
  const secondPassPayload: ChatCompletionsPayload = {
    ...payload,
    messages: secondPassMessages,
    tool_choice: "none",
  }
  consola.debug("Web search second-pass payload:", JSON.stringify(secondPassPayload))

  return createChatCompletions(secondPassPayload)
}

function formatSearchResults(query: string, results: Array<BraveSearchResult>): string {
  if (results.length === 0) {
    return `No results found for: "${query}"`
  }

  const lines: Array<string> = [`Web search results for: "${query}"`, ""]
  for (const [i, result] of results.entries()) {
    lines.push(
      `${i + 1}. Title: ${result.title}`,
      `   URL: ${result.url}`,
      `   Snippet: ${result.description}`,
      "",
    )
  }

  return lines.join("\n").trimEnd()
}
