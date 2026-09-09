import type { AnthropicCustomTool, AnthropicTool } from "./anthropic-types"

import { isTypedTool } from "./anthropic-types"
import { expandClientTool } from "./client-tool-catalog"

export interface ClientTool extends AnthropicCustomTool {
  toolset_name?: string
}

export function clientTools(
  tools: Array<AnthropicTool> = [],
): Array<ClientTool> {
  return tools.flatMap((tool) =>
    isTypedTool(tool) ? (expandClientTool({ ...tool }) ?? []) : [tool],
  )
}
