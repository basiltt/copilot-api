export interface WebSearchResult {
  title: string
  url: string
  description: string
}

export class WebSearchError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`Web search failed: ${reason}`)
    this.name = "WebSearchError"
    this.reason = reason
  }
}

// Backward-compat aliases
export type BraveSearchResult = WebSearchResult
export type BraveSearchError = WebSearchError
export const BraveSearchError = WebSearchError
