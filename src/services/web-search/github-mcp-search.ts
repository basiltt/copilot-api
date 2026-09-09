import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  CallToolResultSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import { WebSearchError } from "./types"

const ENDPOINT = "https://api.githubcopilot.com/mcp/x/all"
const REQUEST_TIMEOUT = 90_000
const MAX_RESPONSE_BYTES = 2_000_000

/** Discover and invoke only GitHub's advertised read-only native web_search. */
export async function callGitHubWebSearch(query: string) {
  if (!state.githubToken)
    throw new WebSearchError(
      "Copilot native search requires the configured GitHub login.",
    )
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT)
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${state.githubToken}`,
        "user-agent": "copilot-api",
      },
      redirect: "error",
    },
    fetch: (url, init) => boundedMcpFetch(url, init, signal),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  })
  const client = new Client(
    { name: "copilot-api", version: "0.7.0" },
    { capabilities: {} },
  )
  const options = {
    signal,
    timeout: REQUEST_TIMEOUT,
    maxTotalTimeout: REQUEST_TIMEOUT,
  }
  try {
    await client.connect(transport, options)
    await requireWebSearch(client, options)
    const result = await client.callTool(
      { name: "web_search", arguments: { query } },
      CallToolResultSchema,
      options,
    )
    return CallToolResultSchema.parse(result)
  } catch (error) {
    if (!(error instanceof McpError)) throw error
    throw new HTTPError(
      "GitHub native search RPC failed",
      Response.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: error.message,
            code: error.code,
            details: error.data,
          },
        },
        { status: 502 },
      ),
    )
  } finally {
    await client.close()
  }
}

async function requireWebSearch(
  client: Client,
  options: { signal: AbortSignal; timeout: number },
) {
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const result = await client.listTools(
      cursor ? { cursor } : undefined,
      options,
    )
    const tool = result.tools.find((entry) => entry.name === "web_search")
    if (tool) {
      const query = tool.inputSchema.properties?.query
      if (
        tool.annotations?.readOnlyHint !== true
        || !query
        || typeof query !== "object"
        || !("type" in query)
        || query.type !== "string"
        || !tool.inputSchema.required?.includes("query")
        || tool.inputSchema.required.some((field) => field !== "query")
      ) {
        throw new WebSearchError(
          "GitHub advertises an unsupported web_search capability contract.",
        )
      }
      return
    }
    cursor = result.nextCursor
    if (!cursor) break
    if (seen.has(cursor))
      throw new WebSearchError("GitHub MCP repeated a tools/list cursor.")
    seen.add(cursor)
  }
  throw new WebSearchError(
    "GitHub MCP does not advertise read-only web_search for this account. No alternative provider was contacted.",
  )
}

async function boundedMcpFetch(
  url: string | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<Response> {
  if (String(url) !== ENDPOINT)
    throw new WebSearchError("Unexpected GitHub MCP transport destination.")
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
  })
  let bytes = 0
  const body = response.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength
        if (bytes > MAX_RESPONSE_BYTES)
          throw new WebSearchError(
            "GitHub MCP search exceeded the response size limit.",
          )
        controller.enqueue(chunk)
      },
    }),
  )
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  // The optional notification GET may legitimately be unsupported.
  if (!response.ok && (init?.method !== "GET" || response.status !== 405))
    throw new HTTPError("GitHub native search request failed", bounded)
  return bounded
}
