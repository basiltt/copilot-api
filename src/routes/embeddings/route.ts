import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { resolveModelId } from "~/lib/model-resolver"
import { state } from "~/lib/state"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const paylod = await c.req.json<EmbeddingRequest>()
    // Normalize the requested model id to a real Copilot model before forwarding.
    paylod.model = resolveModelId(paylod.model, state.models)
    const response = await createEmbeddings(paylod)

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
