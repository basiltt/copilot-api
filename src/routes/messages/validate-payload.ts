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

  return validateMessagesArray(p.messages) ?? validateMaxTokens(p.max_tokens)
}
