import { WebSearchError, type WebSearchResult } from "./types"

const TAVILY_SEARCH_URL = "https://api.tavily.com/search"
const TIMEOUT_MS = 5000
const MAX_RESULTS = 5

export async function searchTavily(
  query: string,
  apiKey: string,
): Promise<Array<WebSearchResult>> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, TIMEOUT_MS)

  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ api_key: apiKey, query, max_results: MAX_RESULTS }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new WebSearchError(`HTTP ${response.status}`)
    }

    const data = (await response.json()) as {
      results?: Array<{ title: string; url: string; content?: string }>
    }

    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.content ?? "",
    }))
  } catch (error) {
    if (error instanceof WebSearchError) {
      throw error
    }
    const reason =
      error instanceof Error ? error.message : "unknown network error"
    throw new WebSearchError(reason)
  } finally {
    clearTimeout(timeoutId)
  }
}
