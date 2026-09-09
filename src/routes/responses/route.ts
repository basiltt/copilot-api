import { Hono } from "hono"

import { forwardOpenAIError } from "~/lib/error"
import { requestLifecycle } from "~/lib/request-lifecycle"

import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()
responsesRoutes.use(requestLifecycle)

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardOpenAIError(c, error)
  }
})
