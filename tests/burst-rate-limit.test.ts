import { describe, test, expect } from "bun:test"

import type { State } from "~/lib/state"

import { checkBurstLimit } from "~/lib/rate-limit"

function makeState(overrides: Partial<State> = {}): State {
  return {
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    burstRequestTimestamps: [],
    ...overrides,
  }
}

describe("checkBurstLimit", () => {
  test("returns immediately when burst limiting is not configured", async () => {
    const state = makeState()
    const start = Date.now()
    await checkBurstLimit(state)
    expect(Date.now() - start).toBeLessThan(50)
    expect(state.burstRequestTimestamps).toHaveLength(0)
  })

  test("returns immediately when only burstCount is set (not configured)", async () => {
    const state = makeState({ burstCount: 3 })
    const start = Date.now()
    await checkBurstLimit(state)
    expect(Date.now() - start).toBeLessThan(50)
  })

  test("returns immediately when only burstWindowSeconds is set (not configured)", async () => {
    const state = makeState({ burstWindowSeconds: 10 })
    const start = Date.now()
    await checkBurstLimit(state)
    expect(Date.now() - start).toBeLessThan(50)
  })

  test("records timestamp and proceeds when under the burst limit", async () => {
    const state = makeState({ burstCount: 3, burstWindowSeconds: 10 })
    await checkBurstLimit(state)
    expect(state.burstRequestTimestamps).toHaveLength(1)
    await checkBurstLimit(state)
    expect(state.burstRequestTimestamps).toHaveLength(2)
    await checkBurstLimit(state)
    expect(state.burstRequestTimestamps).toHaveLength(3)
  })

  test("prunes expired timestamps before checking the limit", async () => {
    const state = makeState({ burstCount: 2, burstWindowSeconds: 1 })
    // Inject 2 timestamps that are already expired (2 seconds ago)
    const expired = Date.now() - 2000
    state.burstRequestTimestamps = [expired, expired]
    // Should proceed immediately (expired entries pruned → window is empty)
    const start = Date.now()
    await checkBurstLimit(state)
    expect(Date.now() - start).toBeLessThan(50)
    expect(state.burstRequestTimestamps).toHaveLength(1)
  })

  test("waits when the window is full and proceeds once a slot opens", async () => {
    // Use a very short window so the test doesn't take long
    const state = makeState({ burstCount: 1, burstWindowSeconds: 0.1 })
    // Fill the window with a timestamp right now
    state.burstRequestTimestamps = [Date.now()]
    const start = Date.now()
    // This call should wait ~100ms for the slot to expire
    await checkBurstLimit(state)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(50) // at least 50ms wait (window is 100ms)
    expect(elapsed).toBeLessThan(500) // but not excessively long
    expect(state.burstRequestTimestamps).toHaveLength(1)
  })
})
