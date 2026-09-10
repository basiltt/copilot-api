import { events } from "fetch-event-stream"

import { requestSignal } from "./request-lifecycle"

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000

export function createInactivityAbort(timeoutMs = INACTIVITY_TIMEOUT_MS) {
  const controller = new AbortController()
  const downstream = requestSignal()
  const signal =
    downstream ?
      AbortSignal.any([downstream, controller.signal])
    : controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    clearTimeout(timer)
    timer = undefined
    signal.removeEventListener("abort", clear)
  }
  const keepAlive = () => {
    clearTimeout(timer)
    if (signal.aborted) return
    timer = setTimeout(() => {
      const error = new Error(
        `Upstream connection inactive for ${Math.round(timeoutMs / 1000)}s`,
      )
      error.name = "TimeoutError"
      controller.abort(error)
    }, timeoutMs)
  }
  signal.addEventListener("abort", clear, { once: true })
  keepAlive()
  return { signal, keepAlive, clear }
}

export async function fetchWithInactivity(
  url: string,
  init: RequestInit,
  inactivity: ReturnType<typeof createInactivityAbort>,
): Promise<Response> {
  try {
    const signal =
      init.signal ?
        AbortSignal.any([inactivity.signal, init.signal])
      : inactivity.signal
    signal.throwIfAborted()
    return await fetch(url, { ...init, signal })
  } catch (error) {
    inactivity.clear()
    throw error
  }
}

export async function readResponseBody(
  response: Response,
  signal: AbortSignal,
  keepAlive?: () => void,
): Promise<string> {
  if (signal.aborted) await response.body?.cancel()
  signal.throwIfAborted()
  if (!response.body) return ""
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk: { value?: unknown; done: boolean } = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) return text + decoder.decode()
      if (!(chunk.value instanceof Uint8Array))
        throw new Error("Upstream completion body contained a non-byte chunk")
      keepAlive?.()
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}
export async function* responseEvents(response: Response, signal: AbortSignal) {
  if (signal.aborted) await response.body?.cancel()
  signal.throwIfAborted()
  if (!response.body) throw new Error("Upstream event stream has no body")
  const reader = response.body.getReader()
  // Cancel the transport reader itself, even while the SSE parser is suspended.
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk: { value?: unknown; done: boolean } = await reader.read()
      if (chunk.done) {
        controller.close()
      } else if (chunk.value instanceof Uint8Array) {
        controller.enqueue(chunk.value)
      } else {
        throw new TypeError("Upstream event stream contained a non-byte chunk")
      }
    },
    cancel,
  })
  try {
    for await (const event of events(new Response(body))) {
      signal.throwIfAborted()
      yield event
    }
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}
