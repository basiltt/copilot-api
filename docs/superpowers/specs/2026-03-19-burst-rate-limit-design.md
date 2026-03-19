# Burst Rate Limiting — Design Spec

**Date:** 2026-03-19
**Status:** Draft

---

## Problem

The existing rate limiter enforces a minimum gap in seconds between every single request (`--rate-limit`). This is too blunt: it penalises requests that are already naturally spaced apart (e.g. an LLM call that only fires after a preceding operation). GitHub Copilot's actual blocking behaviour is triggered by **flooding** — too many requests in a short window — not by any individual request's timing.

---

## Goal

Add a new, independent rate-limiting mode: **burst limiting**. Within a rolling time window of X seconds, allow at most N requests through freely. Any request that would exceed N waits until the oldest slot in the window ages out. Requests that arrive slowly and never saturate the window are never delayed.

---

## Behaviour

- Configured via two CLI flags (both required together): `--burst-count <N>` and `--burst-window <seconds>`
- When a new request arrives, `checkBurstLimit` is called:
  1. Compute `now = Date.now()` for this iteration.
  2. Prune all timestamps older than `now - windowMs` from `state.burstRequestTimestamps`.
  3. If `state.burstRequestTimestamps.length < burstCount` → push `now` synchronously (no `await` between check and push), return immediately.
  4. Otherwise → compute `waitMs = Math.max(0, state.burstRequestTimestamps[0] + windowMs - now)` using the **same `now` from step 1** (do not call `Date.now()` again within this iteration), sleep, then **loop back to step 1** with a fresh `now`. Do not push unconditionally after sleeping.
- The function **always waits** — it never throws a 429. There is no separate `--wait` flag for burst mode.
- Both burst limiting and the existing per-request gap limiter (`--rate-limit`) can be active simultaneously. Burst is checked first.
- `checkBurstLimit` is applied to:
  - `src/routes/chat-completions/handler.ts`
  - `src/routes/messages/handler.ts` (`POST /v1/messages` — actual completions)
- `checkBurstLimit` is **not** applied to:
  - `src/routes/messages/count-tokens-handler.ts` (`POST /v1/messages/count_tokens` — no upstream Copilot completion call)
  - `src/routes/embeddings/handler.ts`
- `checkBurstLimit` assumes pre-validated state (both fields defined and in range). It must not be called unless both `burstCount` and `burstWindowSeconds` are set and valid.

---

## Concurrency & Ordering

`state.burstRequestTimestamps` is a shared mutable array. Because Bun's event loop is single-threaded, two requests cannot execute JavaScript simultaneously — there is no true data race. However, two `async` handlers can interleave at `await` points. The check-and-push in step 3 is **synchronous with no `await` between them**, which prevents two concurrent handlers from both passing the length check before either records a timestamp.

`state.burstRequestTimestamps` is always maintained in **insertion order** (oldest first). Entries are only ever appended via `push`; old entries are pruned via `filter` (which preserves order). This guarantees `state.burstRequestTimestamps[0]` is always the oldest in-window entry after pruning.

---

## State Changes (`src/lib/state.ts`)

New fields added to the `State` interface:

| Field | Type | Default | Purpose |
|---|---|---|---|
| `burstCount` | `number \| undefined` | `undefined` | Max requests allowed within the window |
| `burstWindowSeconds` | `number \| undefined` | `undefined` | Rolling window duration in seconds |
| `burstRequestTimestamps` | `number[]` | `[]` | Timestamps (ms, from `Date.now()`) of in-window requests, oldest first |

All three fields must be initialised in the `state` object literal: `burstCount: undefined`, `burstWindowSeconds: undefined`, `burstRequestTimestamps: []`.

---

## CLI Changes (`src/start.ts`)

Two new `citty` args added to the `start` command (type `"string"`, consistent with the existing `rate-limit` arg):

| Flag | Description |
|---|---|
| `--burst-count` | Max requests within the window (positive integer ≥ 1) |
| `--burst-window` | Window duration in seconds (positive number > 0) |

Two new fields added to the `RunServerOptions` interface as **parsed numbers** (matching the existing `rateLimit?: number` pattern — raw CLI strings are parsed before being passed into `runServer`):

```typescript
burstCount?: number        // parsed from --burst-count
burstWindowSeconds?: number  // parsed from --burst-window
```

**Validation** (applied in the `run()` callback of the `start` command, before calling `runServer`, in this order):

1. If both flags are absent → pass `burstCount: undefined, burstWindowSeconds: undefined` to `runServer`. No warning.
2. If exactly one flag is present → `consola.warn("Burst limiting disabled: --burst-count and --burst-window must both be provided (missing: --<flag-name>)")`, pass both as `undefined`.
3. If both flags are present: parse `--burst-count` with `Number(raw)` and check `Number.isInteger(parsed) && parsed >= 1`. Using `Number()` rather than `parseInt` is intentional here: it catches non-integer floats like `"2.5"` which `parseInt` would silently truncate to `2`. If invalid → `consola.error("--burst-count must be a positive integer (got: <value>)")` and `process.exit(1)`.
4. If both flags are present and count is valid: parse `--burst-window` with `Number(raw)` and check `parsed > 0`. If invalid → `consola.error("--burst-window must be a positive number greater than 0 (got: <value>)")` and `process.exit(1)`.

Rules 3 and 4 are only reached when both flags are present. The process exits immediately on the first parse failure — if rule 3 fails, rule 4 is not evaluated and `--burst-window` is not validated.

**State assignment** (in `runServer`, alongside existing state assignments):

```typescript
state.burstCount = options.burstCount
state.burstWindowSeconds = options.burstWindowSeconds
```

---

## Rate Limit Logic (`src/lib/rate-limit.ts`)

`sleep` is imported from `"./utils"` (already present in this file). `consola` is already imported in this file. No new imports are needed.

New exported function:

```typescript
export async function checkBurstLimit(state: State): Promise<void>
```

Algorithm:

```
1. If state.burstCount is undefined OR state.burstWindowSeconds is undefined → return

2. const windowMs = state.burstWindowSeconds * 1000

3. Loop forever:
   a. const now = Date.now()
   b. state.burstRequestTimestamps = state.burstRequestTimestamps.filter(
        ts => ts > now - windowMs
      )
   c. If state.burstRequestTimestamps.length < state.burstCount:
        state.burstRequestTimestamps.push(now)   // synchronous: no await between check and push
        return
   d. Else:
        const waitMs = Math.max(
          0,
          state.burstRequestTimestamps[0] + windowMs - now  // use same `now` from step 3a
        )
        const waitSeconds = Math.ceil(waitMs / 1000)
        consola.warn(`Burst limit reached. Waiting ${waitSeconds}s before proceeding...`)
        await sleep(waitMs)
        consola.debug("Burst limit wait completed, re-checking...")
        // Note: consola.debug is intentional here (not consola.info) — the loop
        // has not yet confirmed a slot is free, so this is an intermediate state,
        // not a "proceeding with request" event.
        continue  // back to step 3a — now gets a fresh Date.now()
```

The existing `checkRateLimit` function is **not modified**.

---

## Integration Points

`checkBurstLimit(state)` is called as the **first** thing in:

- `src/routes/chat-completions/handler.ts` — before `checkRateLimit(state)`. Add `checkBurstLimit` to the existing `~/lib/rate-limit` import.
- `src/routes/messages/handler.ts` — before `checkRateLimit(state)`. Add `checkBurstLimit` to the existing `~/lib/rate-limit` import.

Not called in:
- `src/routes/messages/count-tokens-handler.ts`
- `src/routes/embeddings/handler.ts`

No changes to routing, middleware, or any other files.

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/state.ts` | Add `burstCount`, `burstWindowSeconds`, `burstRequestTimestamps` to `State` interface and `state` object |
| `src/lib/rate-limit.ts` | Add `checkBurstLimit` function (no new imports needed) |
| `src/start.ts` | Add `--burst-count` and `--burst-window` CLI args; add `burstCount` and `burstWindowSeconds` to `RunServerOptions`; add validation in `run()` callback; add state assignment in `runServer` |
| `src/routes/chat-completions/handler.ts` | Call `checkBurstLimit(state)` before `checkRateLimit(state)` |
| `src/routes/messages/handler.ts` | Call `checkBurstLimit(state)` before `checkRateLimit(state)` |

---

## Non-Goals

- No `--burst-wait` flag (always waits, never errors)
- No changes to the existing `--rate-limit` / `--wait` behaviour
- No changes to embeddings, count_tokens, or any other endpoints
- No UI or config-file support (CLI flags only, consistent with the rest of the project)
