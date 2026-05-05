import consola from "consola"

import type { State } from "./state"

import { HTTPError } from "./error"
import { sleep } from "./utils"

export async function checkRateLimit(state: State) {
  if (state.rateLimitSeconds === undefined) return

  const now = Date.now()

  if (!state.lastRequestTimestamp) {
    state.lastRequestTimestamp = now
    return
  }

  const elapsedSeconds = (now - state.lastRequestTimestamp) / 1000

  if (elapsedSeconds > state.rateLimitSeconds) {
    state.lastRequestTimestamp = now
    return
  }

  const waitTimeSeconds = Math.ceil(state.rateLimitSeconds - elapsedSeconds)

  if (!state.rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
    )
    throw new HTTPError(
      "Rate limit exceeded",
      Response.json({ message: "Rate limit exceeded" }, { status: 429 }),
    )
  }

  const waitTimeMs = waitTimeSeconds * 1000
  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )
  await sleep(waitTimeMs)
  // eslint-disable-next-line require-atomic-updates
  state.lastRequestTimestamp = now
  consola.info("Rate limit wait completed, proceeding with request")
  return
}

const burstQueues = new Map<string, Promise<void>>()

export async function checkBurstLimit(state: State, model?: string) {
  if (state.burstCount === undefined || state.burstWindowSeconds === undefined)
    return

  const key = state.burstScope === "model" && model ? model : "__global__"

  const prev = burstQueues.get(key) ?? Promise.resolve()
  const ticket = prev.then(() => acquireBurstSlot(state, key))
  burstQueues.set(
    key,
    ticket.catch(() => {}),
  )
  return ticket
}

function getTimestamps(state: State, key: string): Array<number> {
  if (key === "__global__") return state.burstRequestTimestamps
  let ts = state.burstPerModelTimestamps.get(key)
  if (!ts) {
    ts = []
    state.burstPerModelTimestamps.set(key, ts)
  }
  return ts
}

function setTimestamps(state: State, key: string, ts: Array<number>) {
  if (key === "__global__") {
    state.burstRequestTimestamps = ts
  } else {
    state.burstPerModelTimestamps.set(key, ts)
  }
}

async function acquireBurstSlot(state: State, key: string) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const windowMs = state.burstWindowSeconds! * 1000
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const maxBurst = state.burstCount!
  const minSpacingMs = state.burstMinSpacingMs
  const label = key === "__global__" ? "" : ` [${key}]`

  while (true) {
    const now = Date.now()

    const filtered = getTimestamps(state, key).filter(
      (ts) => ts > now - windowMs,
    )
    setTimestamps(state, key, filtered)

    if (filtered.length < maxBurst) {
      if (minSpacingMs > 0) {
        const last = filtered.at(-1)
        const elapsed = last !== undefined ? now - last : Infinity
        if (elapsed < minSpacingMs) {
          const gap = minSpacingMs - elapsed
          const gapLabel =
            gap < 1000 ? `${gap}ms` : `${(gap / 1000).toFixed(1)}s`
          consola.debug(`${label} Spacing requests: waiting ${gapLabel}`)
          await sleep(gap)
        }
      }
      getTimestamps(state, key).push(Date.now())
      return
    }

    const oldest = filtered[0] ?? now
    const waitMs = Math.max(0, oldest + windowMs - now)
    const waitLabel =
      waitMs < 1000 ? `${waitMs}ms` : `${(waitMs / 1000).toFixed(1)}s`
    consola.warn(
      `${label} Burst limit reached. Waiting ${waitLabel} before proceeding...`,
    )
    await sleep(waitMs)
    consola.debug(`${label} Burst limit wait completed, re-checking...`)
  }
}
