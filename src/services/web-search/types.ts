export interface BraveSearchResult {
  title: string
  url: string
  description: string
}

export class BraveSearchError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`Brave search failed: ${reason}`)
    this.name = "BraveSearchError"
    this.reason = reason
  }
}