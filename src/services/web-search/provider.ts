import { state } from "~/lib/state"

import { searchBrave } from "./brave"
import { searchCopilot } from "./copilot"
import { searchTavily } from "./tavily"
import { WebSearchError, type WebSearchOutput } from "./types"

export async function searchConfiguredProvider(
  query: string,
): Promise<WebSearchOutput> {
  if (state.webSearchProvider === "copilot") return searchCopilot(query)
  if (state.webSearchProvider === "off")
    throw new WebSearchError("Web search is disabled.")
  if (
    state.tavilyApiKey
    && (!state.webSearchProvider || state.webSearchProvider === "tavily")
  ) {
    return { results: await searchTavily(query, state.tavilyApiKey) }
  }
  if (
    state.braveApiKey
    && (!state.webSearchProvider || state.webSearchProvider === "brave")
  ) {
    return { results: await searchBrave(query, state.braveApiKey) }
  }
  throw new WebSearchError("No supported search provider is configured.")
}
