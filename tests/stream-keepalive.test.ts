import { describe, expect, test } from "bun:test"

import { startSSEKeepalive } from "~/routes/messages/handler"

describe("Anthropic SSE keepalive", () => {
  test("keeps sending pings until stopped", async () => {
    const events: Array<{
      event?: string
      data: string | Promise<string>
    }> = []
    const stop = startSSEKeepalive(
      {
        writeSSE(event) {
          events.push(event)
          return Promise.resolve()
        },
      },
      5,
    )

    try {
      const deadline = Date.now() + 200
      while (events.length < 3 && Date.now() < deadline) {
        await Bun.sleep(5)
      }

      expect(events.length).toBeGreaterThanOrEqual(3)
      expect(events.every((event) => event.event === "ping")).toBeTrue()
    } finally {
      stop()
    }

    const countAfterStop = events.length
    await Bun.sleep(20)
    expect(events).toHaveLength(countAfterStop)
  })
})
