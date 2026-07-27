import { Hono } from "hono"

import { forwardOpenAIError } from "~/lib/error"

import { handleCompletion } from "./handler"

export const completionRoutes = new Hono()

completionRoutes.post("/", async (c) => {
  try {
    return await handleCompletion(c)
  } catch (error) {
    return await forwardOpenAIError(c, error)
  }
})
