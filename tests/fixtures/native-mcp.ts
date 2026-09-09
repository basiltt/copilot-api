export const nativeSearchTool = {
  name: "web_search",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
}

export function nativeSearchResult(
  annotations: Array<unknown> = [
    {
      text: "",
      start_index: 0,
      end_index: 1,
      url_citation: {
        title: "Example reference",
        url: "https://example.com/docs",
      },
    },
  ],
) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          type: "output_text",
          text: {
            value:
              "Copilot-generated research answer mentioning https://not-a-source.invalid.",
            annotations,
          },
          bing_searches: [
            { text: "example", url: "https://www.bing.com/search?q=example" },
          ],
          annotations: null,
        }),
      },
    ],
  }
}

interface FixtureOptions {
  result?: Record<string, unknown>
  pages?: Array<{ tools: Array<unknown>; nextCursor?: string }>
  rpcError?: { code: number; message: string; data?: unknown }
  callStatus?: number
  sse?: boolean
}

export function createNativeMcpFixture(options: FixtureOptions = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const headers: Array<Headers> = []
  let page = 0
  // eslint-disable-next-line complexity -- Fixture dispatch covers negotiation, pagination, JSON/SSE, and failure frames.
  function handle(
    url: string | URL | Request,
    init?: RequestInit,
  ): Response | undefined {
    const target = url instanceof Request ? url.url : String(url)
    if (target !== "https://api.githubcopilot.com/mcp/x/all") return undefined
    headers.push(new Headers(init?.headers))
    if (init?.method === "GET") return new Response(null, { status: 405 })
    if (init?.method === "DELETE") return new Response(null, { status: 204 })
    if (typeof init?.body !== "string")
      throw new Error("Expected MCP JSON body")
    const body = JSON.parse(init.body) as {
      id?: number
      method: string
      params?: Record<string, unknown>
    }
    calls.push(body)
    if (body.method.startsWith("notifications/"))
      return new Response(null, { status: 202 })
    let result: unknown
    switch (body.method) {
      case "initialize": {
        result = {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "github-test", version: "1" },
          capabilities: { tools: {} },
        }
        break
      }
      case "tools/list": {
        const pages = options.pages ?? [{ tools: [nativeSearchTool] }]
        result = pages[Math.min(page++, pages.length - 1)]
        break
      }
      case "tools/call": {
        if (options.callStatus)
          return Response.json(
            {
              error: {
                code: "policy_denied",
                message: "Account policy denied search.",
              },
            },
            { status: options.callStatus },
          )
        if (options.rpcError)
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: options.rpcError,
          })
        result = options.result ?? nativeSearchResult()
        break
      }
      default: {
        throw new Error(`Unexpected native MCP method ${body.method}`)
      }
    }
    const envelope = { jsonrpc: "2.0", id: body.id, result }
    if (options.sse)
      return new Response(
        `event: message\ndata: ${JSON.stringify(envelope)}\n\n`,
        {
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "fixture-session",
          },
        },
      )
    return Response.json(envelope, {
      headers: { "mcp-session-id": "fixture-session" },
    })
  }
  return { calls, headers, handle }
}
