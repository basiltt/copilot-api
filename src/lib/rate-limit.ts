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

export async function checkBurstLimit(state: State) {
  if (state.burstCount === undefined || state.burstWindowSeconds === undefined)
    return

  const windowMs = state.burstWindowSeconds * 1000

  while (true) {
    const now = Date.now()

    state.burstRequestTimestamps = state.burstRequestTimestamps.filter(
      (ts) => ts > now - windowMs,
    )

    if (state.burstRequestTimestamps.length < state.burstCount) {
      // Slot is free — record this request synchronously (no await between
      // the length check and push, preventing interleaving in async handlers).
      state.burstRequestTimestamps.push(now)
      return
    }

    // Window is full — wait until the oldest slot expires.
    // state.burstRequestTimestamps[0] is always defined here because the length
    // check above guarantees at least burstCount (≥1) entries — but we guard
    // defensively to make the invariant explicit.
    const oldest = state.burstRequestTimestamps[0] ?? now
    const waitMs = Math.max(0, oldest + windowMs - now)
    // Use ms for short waits, seconds for long ones — avoids misleading "1s" for a 100ms wait.
    const waitLabel =
      waitMs < 1000 ? `${waitMs}ms` : `${(waitMs / 1000).toFixed(1)}s`
    consola.warn(
      `Burst limit reached. Waiting ${waitLabel} before proceeding...`,
    )
    await sleep(waitMs)
    consola.debug("Burst limit wait completed, re-checking...")
    // Loop back with a fresh Date.now() — do not push unconditionally.
  }
}
