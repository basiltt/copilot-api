import type { Tool } from "~/services/copilot/create-chat-completions"

export const WEB_SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "internet_search",
  "brave_search",
  "bing_search",
  "google_search",
  "find_online",
  "internet_research",
])

export const WEB_SEARCH_FUNCTION_TOOL: Tool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current information. Use this when you need up-to-date facts, recent events, or information beyond your training data.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
}
