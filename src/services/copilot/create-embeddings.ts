import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { requestSignal, throwIfRequestAborted } from "~/lib/request-lifecycle"
import { state } from "~/lib/state"
import { readResponseBody } from "~/lib/upstream-lifecycle"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  throwIfRequestAborted()
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(payload),
    signal: requestSignal(),
  })

  if (!response.ok) throw new HTTPError("Failed to create embeddings", response)

  const signal = requestSignal()
  if (signal)
    return JSON.parse(
      await readResponseBody(response, signal),
    ) as EmbeddingResponse
  return (await response.json()) as EmbeddingResponse
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
