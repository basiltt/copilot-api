import { Hono } from "hono"
import { cors } from "hono/cors"

import "~/lib/context-vars"
import { requestLogger } from "~/lib/request-logger"

import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(requestLogger)
server.use(cors())

server.get("/", (c) => c.text("Server running"))

/**
 * Best-effort connectivity probe.  Claude Code issues `HEAD /` against a
 * configured gateway on startup to check reachability before any inference.
 * Hono answers HEAD via the GET handler, but registering it explicitly keeps
 * the response body-free and cheap.
 */
server.on("HEAD", "/", (c) => c.body(null, 200))

/**
 * Liveness probe.  Claude Desktop's gateway health check and most container
 * orchestrators expect a cheap `/health` endpoint; without one they fall back
 * to probing an inference route, which is slow and bills tokens.
 */
server.get("/health", (c) =>
  c.json({ status: "ok", service: "copilot-api" }, 200),
)

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)

// OpenAI Responses API endpoint
server.route("/v1/responses", responsesRoutes)
server.route("/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
// Some Anthropic-compatible clients call the unprefixed form; every other
// route on this server is registered both ways, so mirror it here too.
server.route("/messages", messageRoutes)
