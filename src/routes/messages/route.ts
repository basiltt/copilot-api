import { Hono } from "hono"

import {
  forwardAnthropicError,
  sendAnthropicInvalidRequestError,
} from "~/lib/error"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"
import { validateAnthropicPayload } from "./validate-payload"

export const messageRoutes = new Hono()

messageRoutes.post("/", async (c) => {
  try {
    // Validate before dispatching so a malformed body produces a spec-shaped
    // 400 `invalid_request_error` rather than a JS TypeError surfacing as a
    // 500 with interpreter internals in the message.  Hono caches the parsed
    // body, so the handler's own `c.req.json()` does not re-read the stream.
    let rawPayload: unknown
    try {
      rawPayload = await c.req.json()
    } catch {
      return sendAnthropicInvalidRequestError(
        c,
        "Request body is not valid JSON.",
      )
    }

    const validationError = validateAnthropicPayload(rawPayload)
    if (validationError) {
      return sendAnthropicInvalidRequestError(c, validationError)
    }

    return await handleCompletion(c)
  } catch (error) {
    return await forwardAnthropicError(c, error)
  }
})

messageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c)
  } catch (error) {
    return await forwardAnthropicError(c, error)
  }
})
