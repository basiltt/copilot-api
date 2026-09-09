import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import type { State } from "~/lib/state"

import { HTTPError } from "~/lib/error"
import { checkAdmission, checkBurstLimit } from "~/lib/rate-limit"

function makeState(overrides: Partial<State> = {}): State {
  return {
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: true,
    showToken: false,
    burstMinSpacingMs: 0,
    burstScope: "global",
    burstRequestTimestamps: [],
    burstPerModelTimestamps: new Map(),
    ...overrides,
  }
}

let now = 0
let dates: ReturnType<typeof spyOn<typeof Date, "now">>
let timers: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>
let clears: ReturnType<typeof spyOn<typeof globalThis, "clearTimeout">>
let tasks: Map<number, { due: number; run: () => void }>
const originalSetTimeout = setTimeout
const originalClearTimeout = clearTimeout

beforeEach(() => {
  now = 0
  tasks = new Map()
  dates = spyOn(Date, "now").mockImplementation(() => now)
  timers = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms = 0,
  ) => {
    const handle = originalSetTimeout(() => undefined, 2147483647)
    originalClearTimeout(handle)
    tasks.set(Number(handle), { due: now + ms, run: callback })
    return handle
  }) as typeof setTimeout)
  clears = spyOn(globalThis, "clearTimeout").mockImplementation(((
    id: Parameters<typeof clearTimeout>[0],
  ) => {
    tasks.delete(Number(id))
  }) as typeof clearTimeout)
})

afterEach(() => {
  dates.mockRestore()
  timers.mockRestore()
  clears.mockRestore()
})

async function advance(to: number) {
  now = to
  for (const [id, task] of tasks) {
    if (task.due <= now) {
      tasks.delete(id)
      task.run()
    }
  }
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("atomic account admission under concurrent waiters", () => {
  test("waiters recheck at actual admission, including timestamp zero", async () => {
    const state = makeState({ rateLimitSeconds: 1 })
    const admitted: Array<number> = []
    const calls = [0, 1, 2].map(async () => {
      await checkAdmission(state)
      admitted.push(now)
    })
    await advance(0)
    expect(admitted).toEqual([0])
    await advance(1000)
    expect(admitted).toEqual([0, 1000])
    await advance(2000)
    await Promise.all(calls)
    expect(admitted).toEqual([0, 1000, 2000])
    expect(state.lastRequestTimestamp).toBe(2000)
    expect(tasks.size).toBe(0)
  })

  test("late scheduler wakeups do not use a stale pre-sleep timestamp", async () => {
    const state = makeState({ rateLimitSeconds: 1, lastRequestTimestamp: 0 })
    const call = checkAdmission(state)
    await advance(1700)
    await call
    expect(state.lastRequestTimestamp).toBe(1700)
  })

  test("combined interval and burst limits commit together, never bunching starts", async () => {
    const state = makeState({
      rateLimitSeconds: 1,
      burstCount: 1,
      burstWindowSeconds: 3,
    })
    const starts: Array<number> = []
    const calls = [0, 1, 2].map(async () => {
      await checkAdmission(state)
      starts.push(now)
    })
    await advance(0)
    await advance(3000)
    expect(starts).toEqual([0, 3000])
    await advance(6000)
    await Promise.all(calls)
    expect(starts).toEqual([0, 3000, 6000])
  })

  test("canceling a waiter releases its timer and consumes no admission", async () => {
    const state = makeState({ rateLimitSeconds: 1, lastRequestTimestamp: 0 })
    const controller = new AbortController()
    const call = checkAdmission(state, { signal: controller.signal })
    controller.abort(new Error("canceled"))
    expect(call).rejects.toThrow("canceled")
    expect(tasks.size).toBe(0)
    expect(state.lastRequestTimestamp).toBe(0)
    now = 1000
    await checkAdmission(state)
    expect(state.lastRequestTimestamp).toBe(1000)
  })

  test("nonwaiting interval mode rejects with 429 and Retry-After", async () => {
    const state = makeState({
      rateLimitSeconds: 2,
      lastRequestTimestamp: 0,
      rateLimitWait: false,
    })
    now = 10
    try {
      await checkAdmission(state)
      throw new Error("Expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      if (!(error instanceof HTTPError)) throw error
      expect(error.response.status).toBe(429)
      expect(error.response.headers.get("retry-after")).toBe("2")
    }
    expect(tasks.size).toBe(0)
  })

  test("independent State objects never share an admission queue", async () => {
    const a = makeState({
      burstCount: 1,
      burstWindowSeconds: 10,
      burstRequestTimestamps: [0],
    })
    const b = makeState({ burstCount: 1, burstWindowSeconds: 10 })
    const controller = new AbortController()
    const waiting = checkBurstLimit(a, undefined, controller.signal)
    await checkBurstLimit(b)
    expect(b.burstRequestTimestamps).toEqual([0])
    controller.abort(new Error("canceled"))
    expect(waiting).rejects.toThrow("canceled")
  })

  test("per-model slots isolate models but an interval still shares the account", async () => {
    const state = makeState({
      burstCount: 1,
      burstWindowSeconds: 10,
      burstScope: "model",
    })
    await checkAdmission(state, { model: "A" })
    await checkAdmission(state, { model: "B" })
    expect(state.burstPerModelTimestamps.size).toBe(2)
    now = 10001
    await checkAdmission(state, { model: "C" })
    expect([...state.burstPerModelTimestamps.keys()]).toEqual(["C"])
    state.rateLimitSeconds = 1
    await checkAdmission(state, { model: "D" })
    const next = checkAdmission(state, { model: "E" })
    expect(tasks.size).toBe(1)
    await advance(11001)
    await next
  })

  test("minimum spacing survives a shorter burst window", async () => {
    const state = makeState({
      burstCount: 5,
      burstWindowSeconds: 1,
      burstMinSpacingMs: 2000,
    })
    await checkBurstLimit(state)
    now = 1001
    const waiting = checkBurstLimit(state)
    await advance(1999)
    expect(state.burstRequestTimestamps).toEqual([0])
    await advance(2000)
    await waiting
    expect(state.burstRequestTimestamps).toEqual([2000])
  })
})
