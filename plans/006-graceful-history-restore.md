# Plan 006: Don't alarm the user when chat-history restore returns nothing/fails on a fresh load

> **Executor instructions**: Write the failing test FIRST, then the fix. Run
> every verification command and confirm the expected result before moving on.
> If anything in "STOP conditions" occurs, stop and report. When done, update
> the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7826299..HEAD -- src/ui/main.ts src/ui/shared.ts`
> If either changed since this plan was written, compare the "Current state"
> excerpts to the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7826299`, 2026-06-14
- **Found**: live, via agent-browser, 2026-06-14 — the embedded chat showed a red
  alert *"Couldn't restore the conversation history — you can keep chatting."* on
  a fresh load while the chat itself worked.

## Why this matters

On the live embedded chat, a fresh load surfaced an **alarming red error bar**
even though the chat was fully functional and there was nothing meaningful to
restore. Root cause traced live: `GET /api/chat/history` returned a non-JSON/non-OK
body (a 404 from a stale dev server, but the same happens on any transient/empty
case), so `getHistory()` resolved to `undefined`, `historyRestoreItems(undefined)`
threw, and `restoreHistory()`'s catch showed the red `role="alert"` bar. A failed
or empty history restore is **non-blocking** (the composer works) and on a fresh
session there is nothing to restore — it should degrade quietly, not alarm. The
current copy even says "you can keep chatting," so the heavy red alert is
mismatched to the severity.

(Operational note, NOT part of this fix: the specific 404 seen live was a stale
dev tunnel server — `scripts/dev-tunnel.sh sync` redeploys current code. This
plan hardens the UI so the symptom can't alarm regardless of the cause.)

## Current state

- `src/ui/main.ts` (~lines 675-695) — `restoreHistory()` treats any throw as a
  user-facing error:

  ```ts
  async function restoreHistory(): Promise<void> {
    try {
      const history = (await api.getHistory()) as HistoryResponse;
      const items = historyRestoreItems(history);
      if (items.length === 0) return;
      chat.querySelector(".welcome")?.remove();
      for (const item of items) {
        if (item.kind === "bubble") appendMessage(item.role, item.text);
        else renderResults(item.results);
      }
      messages.scrollTop = messages.scrollHeight;
    } catch {
      showError("Couldn't restore the conversation history — you can keep chatting.");
    } finally {
      restoreGate.settle();
    }
  }
  ```

- `src/ui/main.ts` (~line 268) — `getHistory()` goes through `json()`, which only
  throws on 401; a non-OK/non-JSON response resolves to `undefined`:

  ```ts
  getHistory: () => json("/api/chat/history"),
  ```

- `src/ui/shared.ts` — `historyRestoreItems(history)` builds the replay list. It
  is the function that throws when `history` is `undefined`/malformed. **Read it**
  to see its exact shape before changing it (it normalizes `history.messages` +
  `history.pendingPreviews`).

- A 401 is special — it means the session expired, and `json()` throws an
  `ApiError(401, SESSION_EXPIRED_MESSAGE)`. That case SHOULD surface (the fix is a
  reload), so preserve it.

- Conventions: ESM (`.js` suffixes); Vitest; TDD; the UI sets text via
  `textContent` only. `historyRestoreItems` is a pure function — unit-testable
  without the DOM.

## Commands you will need

| Purpose        | Command                                                | Expected          |
|----------------|--------------------------------------------------------|-------------------|
| UI restore test| `npx vitest run tests/unit/history-restore.test.ts`    | red, then green (adjust filename to the existing UI test for `historyRestoreItems`) |
| Find the test  | `grep -rln "historyRestoreItems" tests`                | the test file to extend |
| Full gate      | `npm run verify`                                        | exit 0            |

## Scope

**In scope**:
- `src/ui/shared.ts` — make `historyRestoreItems` null/shape-safe (return `[]`
  for `undefined`/malformed input instead of throwing).
- `src/ui/main.ts` — `restoreHistory()`: on a NON-401 failure, degrade quietly
  (no red alert; at most a `console.warn`); keep the 401/session-expired surfacing.
- The existing unit test for `historyRestoreItems` (extend it).
- `plans/README.md` (status row).

**Out of scope** (do NOT touch):
- The server route `/api/chat/history` — this is a UI-resilience fix; the route
  is correct.
- The 401/session-expired path — it must still surface `SESSION_EXPIRED_MESSAGE`.
- The `restoreGate.settle()` in `finally` — it must still run on every path
  (the composer must never wedge).

## Git workflow

- Branch `advisor/006-graceful-restore`, or direct-commit per your workflow. Do
  NOT push/PR unless instructed.
- Commits e.g. `test(ui): pin graceful empty/failed history restore` then
  `fix(ui): degrade quietly when history restore is empty or fails`.

## Steps

### Step 1: Failing test — `historyRestoreItems` is shape-safe

In the existing `historyRestoreItems` test file (find via grep), add cases:
- `historyRestoreItems(undefined)` → `[]` (no throw).
- `historyRestoreItems({})` (missing `messages`/`pendingPreviews`) → `[]`.
- `historyRestoreItems({ messages: [], pendingPreviews: [] })` → `[]`.

**Verify**: the new cases FAIL today (it throws on `undefined`).

### Step 2: Make `historyRestoreItems` null/shape-safe

In `src/ui/shared.ts`, guard the inputs: coerce missing `messages`/
`pendingPreviews` to empty arrays before mapping, so a malformed/empty/`undefined`
response yields `[]` rather than throwing.

**Verify**: `npx vitest run <the test file>` → green.

### Step 3: Degrade quietly in `restoreHistory`

In `src/ui/main.ts`, change the `catch` so a non-401 failure does NOT show the
red alert. Keep surfacing the session-expired case. Target shape:

```ts
    } catch (error) {
      // A failed/empty restore is non-blocking — the composer works and a fresh
      // session has nothing to replay. Only a genuine session expiry (401) is
      // worth surfacing (its fix is a reload); anything else degrades quietly so
      // we never throw an alarming red bar over a benign first-load restore.
      if (error instanceof ApiError && error.status === 401) {
        showError(error.message);
      } else {
        console.warn("history restore skipped:", error instanceof Error ? error.message : String(error));
      }
    } finally {
      restoreGate.settle();
    }
```

**Verify**: `npm run verify` → exit 0.

## Test plan

- Unit: `historyRestoreItems` returns `[]` for `undefined`/`{}`/empty (the
  regression that caused the live alert).
- (If a `restoreHistory`-level test harness exists) a getHistory that rejects
  with a non-401 error does NOT call `showError`; a 401 DOES. If no such harness
  exists, the `historyRestoreItems` unit test + the typed `catch` are sufficient;
  note that in the commit body.
- Regression: existing restore/history tests stay green.

## Done criteria

ALL must hold:

- [ ] `historyRestoreItems(undefined)` returns `[]` (pinned by a test).
- [ ] `restoreHistory` shows no error bar on a non-401 failure; still surfaces 401.
- [ ] `restoreGate.settle()` still runs on every path.
- [ ] `npm run verify` exits 0.
- [ ] `git status` shows only in-scope files changed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:
- `historyRestoreItems` already handles `undefined` gracefully (then the bug is
  elsewhere — report where the throw originates).
- Making the change would require touching the server route (it should not).

## Maintenance notes

- This is purely defensive UI hardening; it does not change what a successful
  restore renders.
- Reviewer: confirm the 401/session-expired path still surfaces, and that
  `restoreGate.settle()` runs on success, quiet-failure, and 401 alike.
- Related: plan 007/008 (chat-history switcher) will add a sessions list; a
  graceful empty-restore is a prerequisite for a clean "switch to an empty/older
  session" experience.
