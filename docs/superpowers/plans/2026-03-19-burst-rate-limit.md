# Burst Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sliding-window burst rate limiter that allows at most N requests within X seconds, throttling excess requests until a slot opens, leaving the existing per-request gap limiter (`--rate-limit`) untouched.

**Architecture:** A new `checkBurstLimit(state)` function in `src/lib/rate-limit.ts` tracks request timestamps in `state.burstRequestTimestamps` (process-wide, shared across all clients of this proxy — appropriate since a single GitHub Copilot token is shared). It prunes expired entries on every call and sleeps until a slot opens if the window is full (retry loop, not FIFO queue — ordering under concurrent load is not guaranteed). Two new CLI flags (`--burst-count`, `--burst-window`) configure it, both required together. The gap limiter (`checkRateLimit`) runs first so its sleep delay happens before the burst timestamp is recorded, keeping timestamps close to actual outbound dispatch time.

**Tech Stack:** Bun runtime, TypeScript, `bun:test` for tests, `consola` for logging, `citty` for CLI arg parsing.

---

## Chunk 1: State and core logic

### Task 1: Extend State with burst limiting fields

**Files:**
- Modify: `src/lib/state.ts`

- [ ] **Step 1: Add the three new fields to the `State` interface and `state` object**

  In `src/lib/state.ts`, add to the `State` interface after the existing rate-limit comment block:

  ```typescript
  // Burst rate limiting configuration
  burstCount?: number
  burstWindowSeconds?: number
  burstRequestTimestamps: number[]
  ```

  And in the `state` object literal, add:

  ```typescript
  burstRequestTimestamps: [],
  ```

  (`burstCount` and `burstWindowSeconds` default to `undefined` automatically since they are optional — no explicit initialisation needed beyond the interface.)

- [ ] **Step 2: Run typecheck to verify no type errors**

  ```bash
  bun run typecheck
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add src/lib/state.ts
  git commit -m "feat: add burst rate limit fields to State"
  ```

---

### Task 2: Implement `checkBurstLimit`

**Files:**
- Modify: `src/lib/rate-limit.ts`
- Create: `tests/burst-rate-limit.test.ts`

- [ ] **Step 1: Write the failing tests**

  Create `tests/burst-rate-limit.test.ts`:

  ```typescript
  import { describe, test, expect, beforeEach } from "bun:test"
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
      expect(elapsed).toBeGreaterThanOrEqual(80) // at least 80ms wait
      expect(elapsed).toBeLessThan(500) // but not excessively long
      expect(state.burstRequestTimestamps).toHaveLength(1)
    })
  })
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  bun test tests/burst-rate-limit.test.ts
  ```

  Expected: all tests fail because `checkBurstLimit` does not exist yet.

- [ ] **Step 3: Implement `checkBurstLimit` in `src/lib/rate-limit.ts`**

  Add this function to the end of `src/lib/rate-limit.ts` (after `checkRateLimit`):

  ```typescript
  export async function checkBurstLimit(state: State): Promise<void> {
    if (state.burstCount === undefined || state.burstWindowSeconds === undefined)
      return

    const windowMs = state.burstWindowSeconds * 1000

    // eslint-disable-next-line no-constant-condition
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
      const waitMs = Math.max(
        0,
        state.burstRequestTimestamps[0] + windowMs - now,
      )
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
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  bun test tests/burst-rate-limit.test.ts
  ```

  Expected: all 6 tests pass.

- [ ] **Step 5: Run full test suite to check for regressions**

  ```bash
  bun test  
  ```

  Expected: all tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add src/lib/rate-limit.ts tests/burst-rate-limit.test.ts
  git commit -m "feat: implement checkBurstLimit sliding-window rate limiter"
  ```

---

## Chunk 2: CLI wiring and handler integration

### Task 3: Add CLI flags and validation to `src/start.ts`

**Files:**
- Modify: `src/start.ts`

- [ ] **Step 1: Add `burstCount` and `burstWindowSeconds` to `RunServerOptions`**

  In `src/start.ts`, find the `RunServerOptions` interface and add two new optional fields after `rateLimitWait`:

  ```typescript
  burstCount?: number
  burstWindowSeconds?: number
  ```

- [ ] **Step 2: Add state assignment in `runServer`**

  In `runServer`, find these two consecutive lines (around line 46–47):

  ```typescript
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  ```

  Add two new lines **immediately after** `state.rateLimitWait = ...` (before `state.showToken`):

  ```typescript
  state.burstCount = options.burstCount
  state.burstWindowSeconds = options.burstWindowSeconds
  ```

- [ ] **Step 3: Add `--burst-count` and `--burst-window` CLI args**

  In the `args` block of the `start` command (after the existing `wait` arg), add:

  ```typescript
  "burst-count": {
    type: "string",
    description:
      "Max requests allowed within the burst window (positive integer). Must be used with --burst-window.",
  },
  "burst-window": {
    type: "string",
    description:
      "Burst window duration in seconds (positive number). Must be used with --burst-count.",
  },
  ```

- [ ] **Step 4: Add parsing and validation in the `run()` callback**

  In the `run({ args })` callback, after the existing `rateLimit` parsing block and before the `return runServer(...)` call, add:

  ```typescript
  const rawBurstCount = args["burst-count"]
  const rawBurstWindow = args["burst-window"]

  let burstCount: number | undefined
  let burstWindowSeconds: number | undefined

  if (rawBurstCount !== undefined && rawBurstWindow !== undefined) {
    const parsedCount = Number(rawBurstCount)
    if (!Number.isInteger(parsedCount) || parsedCount < 1) {
      consola.error(
        `--burst-count must be a positive integer (got: ${rawBurstCount})`,
      )
      process.exit(1)
    }

    const parsedWindow = Number(rawBurstWindow)
    if (!(parsedWindow > 0)) {
      consola.error(
        `--burst-window must be a positive number greater than 0 (got: ${rawBurstWindow})`,
      )
      process.exit(1)
    }

    burstCount = parsedCount
    burstWindowSeconds = parsedWindow
  } else if (rawBurstCount !== undefined || rawBurstWindow !== undefined) {
    const missing = rawBurstCount === undefined ? "--burst-count" : "--burst-window"
    consola.error(
      `--burst-count and --burst-window must both be provided (missing: ${missing})`,
    )
    process.exit(1)
  }
  ```

  Then pass `burstCount` and `burstWindowSeconds` into `runServer(...)`:

  ```typescript
  return runServer({
    // ... existing fields ...
    burstCount,
    burstWindowSeconds,
  })
  ```

- [ ] **Step 5: Run typecheck**

  ```bash
  bun run typecheck
  ```

  Expected: no errors.

  > **Note:** Citty args with `type: "string"` and no `default` produce `string | undefined`. The ESLint rule `@typescript-eslint/no-unnecessary-condition` may flag `=== undefined` checks depending on how citty types the arg. If lint fails on this in Task 5, add `// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition` before the `rawBurstCount !== undefined` / `rawBurstWindow !== undefined` checks (consistent with the existing pattern on line ~214 of `start.ts` for `rateLimitRaw`).

- [ ] **Step 6: Commit**

  ```bash
  git add src/start.ts
  git commit -m "feat: add --burst-count and --burst-window CLI flags with validation"
  ```

---

### Task 4: Wire `checkBurstLimit` into request handlers

**Files:**
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/routes/messages/handler.ts`

- [ ] **Step 1: Update the chat-completions handler**

  In `src/routes/chat-completions/handler.ts`, find the existing import:

  ```typescript
  import { checkRateLimit } from "~/lib/rate-limit"
  ```

  Replace it with:

  ```typescript
  import { checkBurstLimit, checkRateLimit } from "~/lib/rate-limit"
  ```

  Then find the line `await checkRateLimit(state)` in `handleCompletion` and add the burst check immediately **after** it (gap limiter runs first so its sleep occurs before the burst timestamp is recorded):

  ```typescript
  await checkRateLimit(state)
  await checkBurstLimit(state)
  ```

- [ ] **Step 2: Update the messages handler**

  In `src/routes/messages/handler.ts`, find the existing import:

  ```typescript
  import { checkRateLimit } from "~/lib/rate-limit"
  ```

  Replace it with:

  ```typescript
  import { checkBurstLimit, checkRateLimit } from "~/lib/rate-limit"
  ```

  Then find `await checkRateLimit(state)` inside `handleCompletion` (it is on the **second line** of that function, around line 61). Add the burst check immediately **after** it (gap limiter runs first):

  ```typescript
  await checkRateLimit(state)
  await checkBurstLimit(state)
  ```

  Note: `handleCompletion` in this file is more complex than the chat-completions version — it immediately delegates to `handleNonStreaming` or `streamSSE`. Both limiters run at the top before any of that delegation.

- [ ] **Step 3: Run typecheck**

  ```bash
  bun run typecheck
  ```

  Expected: no errors.

- [ ] **Step 4: Run full test suite**

  ```bash
  bun test
  ```

  Expected: all tests pass.

- [ ] **Step 5: Smoke-test the CLI flag help output**

  ```bash
  bun run src/main.ts start --help
  ```

  Expected: `--burst-count` and `--burst-window` appear in the help text.

- [ ] **Step 6: Commit**

  ```bash
  git add src/routes/chat-completions/handler.ts src/routes/messages/handler.ts
  git commit -m "feat: wire checkBurstLimit into chat-completions and messages handlers"
  ```

---

## Chunk 3: Final lint and typecheck

### Task 5: Full lint and typecheck pass

**Files:** (no changes — verification only)

- [ ] **Step 1: Run linter on the whole project**

  ```bash
  bun run lint:all
  ```

  Expected: no errors.

- [ ] **Step 2: Run typecheck**

  ```bash
  bun run typecheck
  ```

  Expected: no errors.

- [ ] **Step 3: Run full test suite one final time**

  ```bash
  bun test
  ```

  Expected: all tests pass.
