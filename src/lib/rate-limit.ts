import consola from "consola"

import type { State } from "./state"

import { HTTPError } from "./error"
import { abortableDelay, requestSignal } from "./request-lifecycle"

interface AdmissionOptions {
  model?: string
  signal?: AbortSignal
  interval?: boolean
  burst?: boolean
}

function intervalDelay(state: State, now: number): number {
  if (
    state.rateLimitSeconds === undefined
    || state.lastRequestTimestamp === undefined
  )
    return 0
  return Math.max(
    0,
    state.lastRequestTimestamp + state.rateLimitSeconds * 1000 - now,
  )
}

function burstSlot(state: State, model: string | undefined, now: number) {
  if (state.burstCount === undefined || state.burstWindowSeconds === undefined)
    return undefined
  const windowMs = state.burstWindowSeconds * 1000
  const horizon = Math.max(windowMs, state.burstMinSpacingMs)
  // Drop idle model histories too, rather than retaining every model ever seen.
  for (const [key, history] of state.burstPerModelTimestamps) {
    const recent = history.filter((time) => time > now - horizon)
    if (recent.length > 0) state.burstPerModelTimestamps.set(key, recent)
    else state.burstPerModelTimestamps.delete(key)
  }
  const key = state.burstScope === "model" && model ? model : undefined
  const history = (
    key ?
      (state.burstPerModelTimestamps.get(key) ?? [])
    : state.burstRequestTimestamps).filter((time) => time > now - horizon)
  const window = history.filter((time) => time > now - windowMs)
  const last = history.at(-1)
  const spacing = last === undefined ? 0 : last + state.burstMinSpacingMs - now
  const capacity =
    window.length < state.burstCount ? 0 : window[0] + windowMs - now
  return { key, history, delay: Math.max(0, spacing, capacity) }
}

/** Reserve start admission atomically, never hold a slot for a response lifetime. */
export async function checkAdmission(
  state: State,
  options: AdmissionOptions = {},
): Promise<void> {
  const signal = options.signal ?? requestSignal()
  while (true) {
    signal?.throwIfAborted()
    const now = Date.now()
    const interval = options.interval === false ? 0 : intervalDelay(state, now)
    if (interval > 0 && !state.rateLimitWait) {
      const retryAfter = Math.ceil(interval / 1000)
      consola.warn(`Rate limit exceeded. Retry after ${retryAfter} seconds.`)
      throw new HTTPError(
        "Rate limit exceeded",
        Response.json(
          { message: "Rate limit exceeded" },
          { status: 429, headers: { "retry-after": String(retryAfter) } },
        ),
      )
    }
    const burst =
      options.burst === false ? undefined : burstSlot(state, options.model, now)
    const delay = Math.max(interval, burst?.delay ?? 0)
    if (delay > 0) {
      consola.debug(`Request admission waiting ${Math.ceil(delay)}ms`)
      await abortableDelay(delay, signal)
      continue
    }
    // No await between checking capacity and updating shared account timestamps.
    if (options.interval !== false && state.rateLimitSeconds !== undefined)
      state.lastRequestTimestamp = now
    if (burst) {
      burst.history.push(now)
      if (burst.key) state.burstPerModelTimestamps.set(burst.key, burst.history)
      else state.burstRequestTimestamps = burst.history
    }
    return
  }
}

export function checkRateLimit(
  state: State,
  signal?: AbortSignal,
): Promise<void> {
  return checkAdmission(state, { signal, burst: false })
}

export function checkBurstLimit(
  state: State,
  model?: string,
  signal?: AbortSignal,
): Promise<void> {
  return checkAdmission(state, { model, signal, interval: false })
}
