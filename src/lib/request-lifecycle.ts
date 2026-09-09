import type { MiddlewareHandler } from "hono"

import { streamSSE as honoStreamSSE } from "hono/streaming"
import { AsyncLocalStorage } from "node:async_hooks"

interface RequestLifetime {
  signal: AbortSignal
  abort: () => void
}

const lifetimes = new AsyncLocalStorage<RequestLifetime>()

/** Only cancellation is ambient; payloads, tool maps and response state stay local. */
export const requestLifecycle: MiddlewareHandler = async (c, next) => {
  const controller = new AbortController()
  const lifetime = {
    signal: AbortSignal.any([c.req.raw.signal, controller.signal]),
    abort: () => controller.abort(new Error("Client disconnected")),
  }
  await lifetimes.run(lifetime, next)
}

export function requestSignal(): AbortSignal | undefined {
  return lifetimes.getStore()?.signal
}

export function throwIfRequestAborted(): void {
  requestSignal()?.throwIfAborted()
}

export const streamSSE: typeof honoStreamSSE = (c, callback, onError) => {
  const lifetime = lifetimes.getStore()
  return honoStreamSSE(
    c,
    async (stream) => {
      stream.onAbort(() => lifetime?.abort())
      try {
        await (lifetime ?
          lifetimes.run(lifetime, () => callback(stream))
        : callback(stream))
      } catch (error) {
        if (!lifetime?.signal.aborted) throw error
      }
    },
    onError,
  )
}

export function abortableDelay(
  ms: number,
  signal = requestSignal(),
): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      const reason: unknown = signal?.reason
      reject(
        reason instanceof Error ? reason : (
          new Error("Request canceled while waiting")
        ),
      )
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}
