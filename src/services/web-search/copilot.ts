import { events } from "fetch-event-stream"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import { copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import { WebSearchError, type WebSearchResult } from "./types"

const skillList = z.object({ skills: z.array(z.object({ slug: z.string() })) })
const webReference = z.object({
  type: z.literal("github.web-search"),
  data: z.object({
    query: z.string(),
    type: z.literal("web-search"),
    results: z.array(
      z.object({
        title: z.string(),
        excerpt: z.string(),
        url: z.url({ protocol: /^https?$/ }),
      }),
    ),
  }),
})

/** Experimental, capability-gated VS Code RemoteAgentChat protocol. */
export async function searchCopilot(
  query: string,
  model: string,
): Promise<Array<WebSearchResult>> {
  if (!state.githubToken)
    throw new WebSearchError(
      "Copilot native search requires the configured GitHub login.",
    )
  const headers = {
    Authorization: `Bearer ${state.githubToken}`,
    "content-type": "application/json",
    Accept: "application/json",
    "user-agent": "copilot-api",
    "x-request-id": randomUUID(),
    "x-github-api-version": "2025-05-01",
  }
  const base = copilotBaseUrl(state)
  const signal = AbortSignal.timeout(90_000)
  const skillsResponse = await fetch(`${base}/skills`, { headers, signal })
  if (!skillsResponse.ok)
    throw new HTTPError("Copilot search skill discovery failed", skillsResponse)
  const skills = skillList.safeParse(await skillsResponse.json())
  assertSearchSkill(skills)
  const response = await fetch(`${base}/agents/chat`, {
    method: "POST",
    headers: {
      ...headers,
      Accept: "text/event-stream",
      "x-request-id": randomUUID(),
    },
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      copilot_thread_id: randomUUID(),
      copilot_skills: ["bing-search"],
      messages: [{ role: "user", content: `Search the web for: ${query}` }],
    }),
  })
  if (!response.ok)
    throw new HTTPError("Copilot native search failed", response)
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new WebSearchError(
      "Copilot native search did not return an event stream.",
    )
  }
  const results = new Map<string, WebSearchResult>()
  let sawReference = false
  let finished = false
  let bytes = 0
  for await (const event of events(response)) {
    if (event.data === "[DONE]") {
      finished = true
      break
    }
    if (!event.data) continue
    bytes += event.data.length
    if (bytes > 2_000_000)
      throw new WebSearchError(
        "Copilot native search exceeded the response size limit.",
      )
    const data = parseSearchEvent(event.data)
    for (const reference of data.copilot_references ?? []) {
      const found = readReference(reference)
      if (!found) continue
      sawReference = true
      for (const result of found) {
        results.set(result.url, {
          title: result.title,
          url: result.url,
          description: result.excerpt,
        })
      }
    }
  }
  if (!finished)
    throw new WebSearchError(
      "Copilot native search stream ended before completion.",
    )
  if (!sawReference)
    throw new WebSearchError(
      "Copilot returned no native search references. Search may be unavailable for this model or account.",
    )
  return [...results.values()]
}

function readReference(reference: unknown) {
  if (
    !reference
    || typeof reference !== "object"
    || !("type" in reference)
    || reference.type !== "github.web-search"
  )
    return undefined
  const parsed = webReference.safeParse(reference)
  if (!parsed.success)
    throw new WebSearchError("Malformed Copilot web-search reference.")
  return parsed.data.data.results
}

function assertSearchSkill(
  skills: ReturnType<typeof skillList.safeParse>,
): void {
  if (!skills.success)
    throw new WebSearchError("Copilot returned an unsupported skills response.")
  if (!skills.data.skills.some((skill) => skill.slug === "bing-search")) {
    throw new WebSearchError(
      "Copilot does not advertise bing-search for this account or organization. No alternative provider was contacted.",
    )
  }
}

const eventEnvelope = z.object({
  copilot_errors: z
    .array(
      z.object({
        type: z.string(),
        code: z.string(),
        message: z.string(),
        agent: z.string(),
        identifier: z.string().optional(),
      }),
    )
    .optional(),
  copilot_references: z.array(z.unknown()).optional(),
  copilot_confirmation: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  choices: z
    .array(z.object({ finish_reason: z.string().nullable().optional() }))
    .optional(),
})

function parseSearchEvent(raw: string): z.infer<typeof eventEnvelope> {
  const parsed = eventEnvelope.safeParse(JSON.parse(raw))
  if (!parsed.success)
    throw new WebSearchError(
      "Malformed Copilot search references or errors envelope.",
    )
  const data = parsed.data
  if (data.copilot_confirmation) {
    throw new WebSearchError(
      "Copilot native search requires user confirmation or authorization. Complete that action in the official client; the proxy will not approve it.",
    )
  }
  if (data.error || (data.copilot_errors && data.copilot_errors.length > 0)) {
    const errors = data.error ? [data.error] : (data.copilot_errors ?? [])
    const messages = errors.map((error) => error.message)
    throw new HTTPError(
      "Copilot native search reported an error",
      Response.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: messages.join("; "),
            details: errors,
          },
        },
        { status: 502 },
      ),
    )
  }
  if (
    data.choices?.some((choice) => choice.finish_reason === "content_filter")
  ) {
    throw new WebSearchError(
      "Copilot policy filtered the native search response.",
    )
  }
  return data
}
