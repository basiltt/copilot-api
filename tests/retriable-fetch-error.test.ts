import { describe, test, expect } from "bun:test"

import { isRetriableFetchError } from "~/routes/messages/handler"

describe("isRetriableFetchError", () => {
  test("treats a socket reset as retriable when ECONNRESET is on error.code", () => {
    // Bun/undici raise ECONNRESET with name "Error" and the marker on `.code`,
    // not `.name`.  This is the real-world shape that previously fell through
    // to a hard 500 instead of being retried.
    const error = Object.assign(new Error("The socket connection was closed"), {
      code: "ECONNRESET",
    })

    expect(isRetriableFetchError(error)).toBe(true)
  })

  test("treats an inactivity TimeoutError (marker on error.name) as retriable", () => {
    const error = new Error("Upstream connection inactive for 300s")
    error.name = "TimeoutError"

    expect(isRetriableFetchError(error)).toBe(true)
  })

  test("does not retry an unrelated error", () => {
    const error = Object.assign(new Error("boom"), { code: "ERR_UNKNOWN" })

    expect(isRetriableFetchError(error)).toBe(false)
  })

  test("does not retry a non-Error value", () => {
    expect(isRetriableFetchError("nope")).toBe(false)
  })
})
