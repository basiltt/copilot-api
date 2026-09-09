import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean
  structuredOutputRecovery?: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Burst rate limiting configuration
  burstCount?: number
  burstWindowSeconds?: number
  burstMinSpacingMs: number
  burstScope: "global" | "model"
  burstRequestTimestamps: Array<number>
  burstPerModelTimestamps: Map<string, Array<number>>

  // Web search configuration
  braveApiKey?: string
  tavilyApiKey?: string
  webSearchProvider?: "copilot" | "tavily" | "brave" | "off"
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  structuredOutputRecovery: false,
  burstRequestTimestamps: [],
  burstMinSpacingMs: 0,
  burstScope: "global",
  burstPerModelTimestamps: new Map(),
}

export function isWebSearchEnabled(): boolean {
  if (state.webSearchProvider === "off") return false
  if (state.webSearchProvider === "copilot") return true
  if (state.webSearchProvider === "tavily") return Boolean(state.tavilyApiKey)
  if (state.webSearchProvider === "brave") return Boolean(state.braveApiKey)
  return Boolean(state.braveApiKey) || Boolean(state.tavilyApiKey)
}
