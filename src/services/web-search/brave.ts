import { BraveSearchError, type BraveSearchResult } from "./types"

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
const TIMEOUT_MS = 5000
const MAX_RESULTS = 5

export async function searchBrave(
  query: string,
  apiKey: string,
): Promise<BraveSearchResult[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, TIMEOUT_MS)

  try {
    const url = new URL(BRAVE_SEARCH_URL)
    url.searchParams.set("q", query)
    url.searchParams.set("count", String(MAX_RESULTS))

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new BraveSearchError(`HTTP ${response.status}`)
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          title: string
          url: string
          description?: string
        }>
      }
    }

    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description ?? "",
    }))
  } catch (error) {
    if (error instanceof BraveSearchError) {
      throw error
    }
    const reason =
      error instanceof Error ? error.message : "unknown network error"
    throw new BraveSearchError(reason)
  } finally {
    clearTimeout(timeoutId)
  }
}
