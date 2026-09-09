import { z } from "zod"

import { HTTPError } from "~/lib/error"

import { callGitHubWebSearch } from "./github-mcp-search"
import {
  WebSearchError,
  type WebSearchOutput,
  type WebSearchResult,
} from "./types"

const nativeAnswer = z.object({
  type: z.literal("output_text"),
  text: z.object({
    value: z.string(),
    annotations: z.array(
      z.object({
        url_citation: z.object({
          title: z.string(),
          url: z.url({ protocol: /^https?$/ }),
        }),
      }),
    ),
  }),
})

/** Source links and AI synthesis are distinct; this endpoint supplies no source excerpts. */
export async function searchCopilot(query: string): Promise<WebSearchOutput> {
  const response = await callGitHubWebSearch(query)
  if (response.isError) {
    throw new HTTPError(
      "GitHub web_search reported an error",
      Response.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: response.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
            details: response,
          },
        },
        { status: 502 },
      ),
    )
  }
  if (response.content.length === 0)
    throw new WebSearchError("GitHub web_search returned no result envelope.")
  const results = new Map<string, WebSearchResult>()
  const summaries: Array<string> = []
  for (const block of response.content) {
    if (block.type !== "text")
      throw new WebSearchError("Unsupported GitHub web_search content block.")
    const answer = decodeNativeAnswer(block.text)
    summaries.push(answer.text.value)
    for (const annotation of answer.text.annotations) {
      const { title, url } = annotation.url_citation
      results.set(url, { title, url, description: "" })
    }
  }
  return { results: [...results.values()], summary: summaries.join("\n\n") }
}

function decodeNativeAnswer(raw: string): z.infer<typeof nativeAnswer> {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new WebSearchError("GitHub web_search returned invalid result JSON.")
  }
  const parsed = nativeAnswer.safeParse(json)
  if (!parsed.success)
    throw new WebSearchError(
      "Unsupported GitHub web_search answer/citation schema.",
    )
  return parsed.data
}
