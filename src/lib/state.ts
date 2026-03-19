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

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Burst rate limiting configuration
  burstCount?: number
  burstWindowSeconds?: number
  burstRequestTimestamps: Array<number>

  // Web search configuration
  braveApiKey?: string
  tavilyApiKey?: string
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  burstRequestTimestamps: [],
}

export function isWebSearchEnabled(): boolean {
  return Boolean(state.braveApiKey) || Boolean(state.tavilyApiKey)
}
