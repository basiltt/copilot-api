import { describe, expect, spyOn, test } from "bun:test"

import { startSSEKeepalive } from "~/routes/messages/handler"

describe("Anthropic SSE keepalive", () => {
  test("keeps sending pings until stopped", () => {
    const events: Array<{
      event?: string
      data: string | Promise<string>
    }> = []
    const intervals = spyOn(globalThis, "setInterval")
    const clear = spyOn(globalThis, "clearInterval")
    let stop: (() => void) | undefined
    try {
      stop = startSSEKeepalive(
        {
          writeSSE(event) {
            events.push(event)
            return Promise.resolve()
          },
        },
        5,
      )
      expect(intervals).toHaveBeenCalledTimes(1)
      expect(intervals.mock.calls[0]?.[1]).toBe(5)
      const tick = intervals.mock.calls[0]?.[0]
      if (typeof tick !== "function")
        throw new TypeError("Keepalive must register an interval callback")
      const timer = intervals.mock.results[0]
      expect(timer.type).toBe("return")
      expect(timer.value).toBeDefined()

      tick()
      tick()
      tick()
      expect(events).toEqual(
        Array.from({ length: 3 }, () => ({
          event: "ping",
          data: JSON.stringify({ type: "ping" }),
        })),
      )

      stop()
      expect(clear).toHaveBeenCalledTimes(1)
      expect(clear).toHaveBeenCalledWith(timer.value)
    } finally {
      stop?.()
      intervals.mockRestore()
      clear.mockRestore()
    }
  })
})
