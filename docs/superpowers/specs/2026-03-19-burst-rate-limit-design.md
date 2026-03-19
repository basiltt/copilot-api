# Burst Rate Limiting — Design Spec

**Date:** 2026-03-19
**Status:** Approved

---

## Problem

The existing rate limiter enforces a minimum gap in seconds between every single request (`--rate-limit`). This is too blunt: it penalises requests that are already naturally spaced apart (e.g. an LLM call that only fires after a preceding operation). GitHub Copilot's actual blocking behaviour is triggered by **flooding** — too many requests in a short window — not by any individual request's timing.

---

## Goal

Add a new, independent rate-limiting mode: **burst limiting**. Within a rolling time window of X seconds, allow at most N requests through freely. Any request that would exceed N waits until the oldest slot in the window ages out. Requests that arrive slowly and never saturate the window are never delayed.

---

## Behaviour

- Configured via two CLI flags (both required together): `--burst-count <N>` and `--burst-window <seconds>`
- If only one flag is provided, the server logs a warning and disables burst limiting entirely
- When a new request arrives:
  1. Drop all timestamps older than `now - windowMs` from the in-memory list
  2. If `list.length < burstCount` → record timestamp and proceed immediately
  3. If `list.length >= burstCount` → compute how long until the oldest timestamp expires, sleep that long, then record and proceed
- The function **always waits** — it never throws a 429. There is no separate `--wait` flag for burst mode.
- Both burst limiting and the existing per-request gap limiter (`--rate-limit`) can be active simultaneously. Burst is checked first.

---

## State Changes (`src/lib/state.ts`)

New fields added to the `State` interface:

| Field | Type | Default | Purpose |
|---|---|---|---|
| `burstCount` | `number \| undefined` | `undefined` | Max requests allowed within the window |
| `burstWindowSeconds` | `number \| undefined` | `undefined` | Rolling window duration in seconds |
| `burstRequestTimestamps` | `number[]` | `[]` | Timestamps (ms) of requests within the current window |

---

## CLI Changes (`src/start.ts`)

Two new args added to the `start` command and `RunServerOptions` interface:

| Flag | Type | Description |
|---|---|---|
| `--burst-count` | `string` (parsed to `number`) | Max requests within the window |
| `--burst-window` | `string` (parsed to `number`) | Window duration in seconds |

Validation: if exactly one of the two flags is provided (but not both), log a `consola.warn` and set both state fields to `undefined`.

---

## Rate Limit Logic (`src/lib/rate-limit.ts`)

New exported function added alongside the existing `checkRateLimit`:

```typescript
export async function checkBurstLimit(state: State): Promise<void>
```

Algorithm:

```
1. If burstCount or burstWindowSeconds is undefined → return early (disabled)
2. const now = Date.now()
3. const windowMs = burstWindowSeconds * 1000
4. Filter burstRequestTimestamps: keep only entries where ts > now - windowMs
5. If timestamps.length < burstCount:
     push now, return
6. Else:
     const oldestTs = timestamps[0]  // earliest in window
     const waitMs = (oldestTs + windowMs) - now
     log warning "Burst limit reached. Waiting Xs before proceeding..."
     await sleep(waitMs)
     // Re-filter after sleep (time has passed)
     const newNow = Date.now()
     state.burstRequestTimestamps = state.burstRequestTimestamps.filter(
       ts => ts > newNow - windowMs
     )
     state.burstRequestTimestamps.push(newNow)
     log info "Burst limit wait completed, proceeding with request"
     return
```

The existing `checkRateLimit` function is **not modified**.

---

## Integration Points

`checkBurstLimit(state)` is called before `checkRateLimit(state)` in both request handlers:

- `src/routes/chat-completions/handler.ts`
- `src/routes/messages/handler.ts`

No changes to routing, middleware, or any other files.

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/state.ts` | Add `burstCount`, `burstWindowSeconds`, `burstRequestTimestamps` to `State` interface and initial `state` object |
| `src/lib/rate-limit.ts` | Add `checkBurstLimit` function |
| `src/start.ts` | Add `--burst-count` and `--burst-window` CLI args; wire into `RunServerOptions` and `runServer` |
| `src/routes/chat-completions/handler.ts` | Call `checkBurstLimit(state)` before `checkRateLimit(state)` |
| `src/routes/messages/handler.ts` | Call `checkBurstLimit(state)` before `checkRateLimit(state)` |

---

## Non-Goals

- No `--burst-wait` flag (always waits, never errors)
- No changes to the existing `--rate-limit` / `--wait` behaviour
- No UI or config-file support (CLI flags only, consistent with the rest of the project)
