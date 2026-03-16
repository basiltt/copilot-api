import consola from "consola"

import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
  type ChatCompletionResponse,
  type Message,
} from "~/services/copilot/create-chat-completions"

import { searchBrave } from "./brave"
import { BraveSearchError, type BraveSearchResult } from "./types"

type SecondPassOptions = {
  payload: ChatCompletionsPayload
  choice: ChatCompletionResponse["choices"][number]
  webSearchCallId: string
  toolResultContent: string
}

export async function webSearchInterceptor(
  payload: ChatCompletionsPayload,
): ReturnType<typeof createChatCompletions> {
  // First pass: always non-streaming so we can inspect finish_reason
  const firstPassPayload: ChatCompletionsPayload = { ...payload, stream: false }
  const firstResponse = (await createChatCompletions(
    firstPassPayload,
  )) as ChatCompletionResponse

  const choice = firstResponse.choices.at(0)
  if (!choice || choice.finish_reason !== "tool_calls" || !choice.message.tool_calls) {
    return firstResponse
  }

  const webSearchCall = choice.message.tool_calls.find(
    (tc) => tc.function.name === "web_search",
  )
  if (!webSearchCall) {
    return firstResponse
  }

  // Parse query and perform search
  let toolResultContent: string
  try {
    const args = JSON.parse(webSearchCall.function.arguments) as { query: string }
    const query = args.query

    let results: Array<BraveSearchResult> = []
    try {
      if (!state.braveApiKey) throw new BraveSearchError("BRAVE_API_KEY not set")
      results = await searchBrave(query, state.braveApiKey)
    } catch (error: unknown) {
      const reason = error instanceof BraveSearchError ? error.reason : String(error)
      consola.warn(`Web search failed: ${reason}`)
      toolResultContent = `Web search failed: ${reason}\nPlease answer based on your training data and let the user know that web search is currently unavailable.`
      return await buildSecondPass({ payload, choice, webSearchCallId: webSearchCall.id, toolResultContent })
    }

    toolResultContent = formatSearchResults(query, results)
  } catch {
    consola.warn("Web search: failed to parse tool call arguments")
    toolResultContent =
      "Web search failed: could not parse search query.\nPlease answer based on your training data and let the user know that web search is currently unavailable."
  }

  return buildSecondPass({ payload, choice, webSearchCallId: webSearchCall.id, toolResultContent })
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

  // Second pass: use original stream flag
  return createChatCompletions({
    ...payload,
    messages: secondPassMessages,
  })
}

function formatSearchResults(query: string, results: Array<BraveSearchResult>): string {
  if (results.length === 0) {
    return `No results found for: "${query}"`
  }

  const lines: Array<string> = [`Web search results for: "${query}"`, ""]
  for (const [i, result] of results.entries()) {
    lines.push(`${i + 1}. Title: ${result.title}`, `   URL: ${result.url}`, `   Snippet: ${result.description}`, "")
  }

  return lines.join("\n").trimEnd()
}
