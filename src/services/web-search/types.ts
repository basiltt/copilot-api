export interface WebSearchResult {
  title: string
  url: string
  description: string
}

export interface WebSearchOutput {
  results: Array<WebSearchResult>
  /** Provider-generated synthesis, never an original source excerpt or quotation. */
  summary?: string
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
export const BraveSearchError = WebSearchError
