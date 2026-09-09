import { state } from "~/lib/state"

import { searchBrave } from "./brave"
import { searchCopilot } from "./copilot"
import { searchTavily } from "./tavily"
import { WebSearchError, type WebSearchResult } from "./types"

export async function searchConfiguredProvider(
  query: string,
  model: string,
): Promise<Array<WebSearchResult>> {
  if (state.webSearchProvider === "copilot") return searchCopilot(query, model)
  if (state.webSearchProvider === "off")
    throw new WebSearchError("Web search is disabled.")
  if (
    state.tavilyApiKey
    && (!state.webSearchProvider || state.webSearchProvider === "tavily")
  ) {
    return searchTavily(query, state.tavilyApiKey)
  }
  if (
    state.braveApiKey
    && (!state.webSearchProvider || state.webSearchProvider === "brave")
  ) {
    return searchBrave(query, state.braveApiKey)
  }
  throw new WebSearchError("No supported search provider is configured.")
}
