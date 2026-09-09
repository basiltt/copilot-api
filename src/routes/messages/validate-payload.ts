/**
 * Request-shape validation for the Anthropic Messages endpoint.
 *
 * The real API rejects malformed bodies with a `400 invalid_request_error`.
 * Without this, a missing `messages` array surfaced as a JS `TypeError`
 * ("undefined is not an object (evaluating 'payload.messages')") and became an
 * HTTP 500 that leaked interpreter internals — which clients treat as a
 * non-retriable server fault rather than a fixable client mistake.
 *
 * Validation lives here, and runs in the route wrapper rather than the handler,
 * so the handler stays focused on translation.
 */
import { expandClientTool } from "./client-tool-catalog"

const WEB_SEARCH_TYPES = new Set([
  "web_search_20250305",
  "web_search_20260209",
  "web_search_20260318",
])

function validateTools(tools: unknown): string | undefined {
  if (tools === undefined) return undefined
  if (!Array.isArray(tools)) return "`tools` must be an array."
  const names = new Set<string>()
  for (const [index, entry] of (tools as Array<unknown>).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return `tools.${index}: must be an object.`
    const tool = entry as Record<string, unknown>
    try {
      for (const identity of toolIdentities(tool)) {
        if (names.has(identity))
          return `tools.${index}: duplicate tool or toolset identity.`
        names.add(identity)
      }
    } catch (error) {
      return `tools.${index}: ${error instanceof Error ? error.message : "invalid client tool definition"}.`
    }
  }
  return undefined
}

function toolIdentities(tool: Record<string, unknown>): Array<string> {
  if ("input_schema" in tool) {
    validateCustomTool(tool)
    return [JSON.stringify(["client", tool.name])]
  }
  if (typeof tool.type === "string" && WEB_SEARCH_TYPES.has(tool.type)) {
    if (tool.name !== "web_search")
      throw new Error('Web search requires name "web_search"')
    return [JSON.stringify(["server", "web_search"])]
  }
  const expanded = expandClientTool(tool)
  if (!expanded)
    throw new Error(
      `${String(tool.type)} is not a supported client tool. Anthropic hosted discovery, sandbox, advisor, and remote MCP execution are not supplied by Copilot; use client-executed custom tools instead`,
    )
  const scoped = expanded[0].toolset_name
  return scoped ?
      [JSON.stringify(["toolset", scoped]), JSON.stringify(["client", scoped])]
    : expanded.map((member) => JSON.stringify(["client", member.name]))
}

function validateCustomTool(tool: Record<string, unknown>): void {
  if (tool.type !== undefined && tool.type !== null && tool.type !== "custom") {
    throw new Error(
      "Typed tools cannot become custom executors by supplying input_schema",
    )
  }
  if (typeof tool.name !== "string" || !tool.name)
    throw new Error("name must be a non-empty string")
  if (
    !tool.input_schema
    || typeof tool.input_schema !== "object"
    || Array.isArray(tool.input_schema)
  ) {
    throw new Error("input_schema must be a JSON Schema object")
  }
  const callers = tool.allowed_callers
  if (
    callers !== undefined
    && (!Array.isArray(callers)
      || callers.length !== 1
      || callers[0] !== "direct")
  ) {
    throw new Error(
      'Only allowed_callers: ["direct"] is supported; Anthropic programmatic execution is not available through Copilot',
    )
  }
}

/**
 * Validates the `messages` array.
 *
 * @returns an error message when invalid, or `undefined` when valid.
 */
function validateMessagesArray(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return "`messages` is required and must be an array."
  }

  if (messages.length === 0) {
    return "`messages` must contain at least one message."
  }

  for (const [i, raw] of (messages as Array<unknown>).entries()) {
    if (raw === null || typeof raw !== "object") {
      return `messages.${i}: each message must be an object.`
    }
    const msg = raw as Record<string, unknown>
    // The Anthropic Messages API recognizes THREE roles in `messages[]`:
    // "user", "assistant", and "system" (mid-conversation system
    // instructions, sent by the Claude app / Claude Code v1.24012.92+).
    // The LLM gateway protocol is explicit that a gateway must not reject
    // unrecognized roles/fields — "treat the body fields as open lists, not
    // closed ones" — because doing so makes the client silently disable the
    // feature (e.g. mid-conversation system messages) for the rest of the
    // conversation. So we only reject a role that is missing or not a string;
    // the translation layer maps "user"/"system" explicitly and safely
    // defaults every other role to "assistant".
    // @see https://code.claude.com/docs/en/llm-gateway-protocol
    if (typeof msg.role !== "string" || msg.role.length === 0) {
      return `messages.${i}.role: must be a non-empty string.`
    }
    if (typeof msg.content !== "string" && !Array.isArray(msg.content)) {
      return `messages.${i}.content: must be a string or an array of content blocks.`
    }
  }

  return undefined
}

/**
 * Validates `max_tokens` when present.
 *
 * The Anthropic spec marks it required, but omitting it is harmless here (the
 * handler clamps a missing value downstream), so only bad *types* are rejected.
 */
function validateMaxTokens(maxTokens: unknown): string | undefined {
  if (maxTokens === undefined) return undefined
  if (
    typeof maxTokens !== "number"
    || !Number.isInteger(maxTokens)
    || maxTokens < 1
  ) {
    return "`max_tokens` must be a positive integer."
  }
  return undefined
}

/**
 * Validates an incoming Anthropic Messages payload before any translation.
 *
 * @returns an error message when invalid, or `undefined` when the payload is OK.
 */
export function validateAnthropicPayload(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return "Request body must be a JSON object."
  }

  const p = payload as Record<string, unknown>

  if (typeof p.model !== "string" || p.model.trim() === "") {
    return "`model` is required and must be a non-empty string."
  }

  if (
    (p.mcp_servers !== null
      && p.mcp_servers !== undefined
      && (!Array.isArray(p.mcp_servers) || p.mcp_servers.length > 0))
    || (p.container !== null && p.container !== undefined)
    || (p.context_management !== null && p.context_management !== undefined)
  ) {
    return "Anthropic mcp_servers, container, and context_management execution are not supported through Copilot. Use client-managed tools and conversation state."
  }
  return (
    validateMessagesArray(p.messages)
    ?? validateMaxTokens(p.max_tokens)
    ?? validateTools(p.tools)
  )
}
