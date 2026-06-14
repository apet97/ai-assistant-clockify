# Plan 003: Make post-commit bookkeeping best-effort so a DB hiccup can't lose a committed receipt's audit trail

> **Executor instructions**: Follow this plan step by step. Write the failing
> test FIRST (Step 1), then make it pass (Step 2). Run every verification
> command and confirm the expected result before moving on. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When
> done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7826299..HEAD -- src/routes/api.ts`
> If `api.ts` changed since this plan was written, compare the "Current state"
> excerpt against the live code (especially the `commitConfirmation` function);
> on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (but on the safety-critical commit path — read STOP conditions)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7826299`, 2026-06-14

## Why this matters

When an admin confirms a risky write, `commitConfirmation` (in
`src/routes/api.ts`) runs the irreversible commit through the single choke point
(`commitConfirmedOperation`), then does three **post-commit** bookkeeping
writes: `setConfirmationResult` (records the receipt on the preview),
`addAuditEvent` (the audit-log entry), and `recordUndoIfReversible` (the undo
handle). Those three run **un-isolated**: if any throws (e.g. a transient
`SQLITE_BUSY` in the microsecond after the commit), the whole function throws →
the route's terminal error handler returns a 500, and the **audit event and
result are lost AND the admin never receives the receipt for a change that
already happened** (money may have moved — an invoice created, a payment
recorded). For an audit-centric safety tool, silently dropping the audit trail
of a committed financial write is the worst-case outcome.

The commit itself is already durably recorded in the idempotency ledger
(`fillIdempotency` runs inside `commitConfirmedOperation` before this point), so
the post-commit writes are genuinely best-effort: on failure we should log and
still return the receipt, not 500. A later re-confirm replays idempotently and
re-attempts the bookkeeping.

## Current state

- `src/routes/api.ts` — inside `async function commitConfirmation(...)`, after
  the commit completes (`receipt = await commitConfirmedOperation(...)`), the
  un-isolated tail (lines ~796-807):

  ```ts
      deps.store.setConfirmationResult(record.id, receipt.ok ? "used" : "failed", receipt);
      deps.store.addAuditEvent({
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        actionName: operation.actionName,
        risk: operation.risks,
        receipt,
      });
      const undoId = recordUndoIfReversible(claims, receipt);
      const agentState = receipt.ok ? parseAgentState(record.agentState) : undefined;
      return { ok: true, receipt, undoId, agentState, installation };
  ```

  Everything ABOVE this excerpt (the `confirmPending` validation, the policy
  re-check, the `markConfirmationUsed` one-use claim, the
  `commitConfirmedOperation` call) is the safety boundary and MUST NOT be
  touched by this plan.

- `better-sqlite3` is synchronous, so these `deps.store.*` calls throw
  synchronously on a DB error. `parseAgentState` is pure (no DB) and is safe to
  leave outside the try/catch.

- Logging convention (from `src/server.ts`): log the error **message only**,
  never the error object/headers/tokens — e.g.
  `console.error("…:", error instanceof Error ? error.message : String(error))`.

- TDD convention (CLAUDE.md "Engineering rules"): failing test first, then the
  fix. Confirm/commit flows are exercised by integration tests under
  `tests/integration/` (e.g. `safe-writes.test.ts`, `risky-preview.test.ts`,
  `agentic-chat.test.ts`) which build the app with a fake store via Supertest.

## Commands you will need

| Purpose        | Command                                              | Expected          |
|----------------|-----------------------------------------------------|-------------------|
| New test       | `npx vitest run tests/integration/<yourfile>.test.ts` | red, then green |
| Confirm-flow tests | `npx vitest run tests/integration/risky-preview.test.ts tests/integration/safe-writes.test.ts` | all pass |
| Full gate      | `npm run verify`                                     | exit 0            |

## Scope

**In scope**:
- `src/routes/api.ts` — ONLY the post-commit tail of `commitConfirmation`
  (the excerpt above).
- A test file under `tests/integration/` (extend an existing confirm-flow test
  file, or add a focused one e.g. `tests/integration/commit-bookkeeping.test.ts`).
- `plans/README.md` (status row).

**Out of scope** (do NOT touch):
- Anything in `commitConfirmation` ABOVE the excerpt: `confirmPending`, the
  policy re-check, `markConfirmationUsed`, `getInstallation`, the idempotency
  ledger wiring, `commitConfirmedOperation`. Changing the order or guards there
  is a safety regression.
- `src/harness/actions.ts` (`commitConfirmedOperation` itself) and the
  idempotency ledger — unchanged.
- The `/confirmations/:id/confirm`, `/chat/stream`, `/undo/:id` route handlers.

## Git workflow

- Branch `advisor/003-post-commit-isolation`, or direct-commit per your
  workflow. Do NOT push/PR unless instructed.
- Commit(s) e.g. `test(api): pin best-effort post-commit bookkeeping` then
  `fix(api): isolate post-commit bookkeeping so a DB error can't drop a receipt`
  (or one combined commit).

## Steps

### Step 1: Write the failing test

Add an integration test that drives a full preview → confirm of a safe-ish risky
write, but with a fake store whose `addAuditEvent` (or `setConfirmationResult`)
throws once. Model it on an existing confirm-flow test (open
`tests/integration/risky-preview.test.ts` to copy the app/Supertest setup and
the preview→confirm sequence).

The test must assert that, despite the throwing bookkeeping call:
- the confirm response is success (HTTP 200 / `ok: true`) and carries the
  committed receipt — NOT a 500;
- the commit happened exactly once (the underlying fake client recorded one
  create/mutation).

To inject the throw: wrap the fake store passed into `createApp`'s deps so the
chosen method throws on first call, e.g.
`{ ...store, addAuditEvent: () => { throw new Error("db busy"); } }`.

**Verify**: `npx vitest run tests/integration/<yourfile>.test.ts` → the new test
FAILS (today the route 500s / the promise rejects). If it already passes, STOP —
the behavior may already be isolated; report what you found.

### Step 2: Isolate the post-commit bookkeeping

Wrap the three bookkeeping writes in a try/catch that logs (message only) and
continues, so the committed receipt is always returned. Keep `parseAgentState`
and the `return` outside the try. Target shape:

```ts
    let undoId: string | undefined;
    try {
      // Post-commit bookkeeping is best-effort: the commit already happened and
      // is durably recorded in the idempotency ledger. A DB hiccup here (e.g. a
      // transient SQLITE_BUSY) must NOT drop the receipt on the floor or 500 the
      // turn — log (message only, no secrets) and still return the receipt.
      deps.store.setConfirmationResult(record.id, receipt.ok ? "used" : "failed", receipt);
      deps.store.addAuditEvent({
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        actionName: operation.actionName,
        risk: operation.risks,
        receipt,
      });
      undoId = recordUndoIfReversible(claims, receipt);
    } catch (error) {
      console.error(
        "post-commit bookkeeping failed (commit already applied; receipt preserved):",
        error instanceof Error ? error.message : String(error),
      );
    }
    const agentState = receipt.ok ? parseAgentState(record.agentState) : undefined;
    return { ok: true, receipt, undoId, agentState, installation };
```

**Verify**: `npx vitest run tests/integration/<yourfile>.test.ts` → the new test
PASSES.

### Step 3: Full verification

**Verify**:
- `npx vitest run tests/integration/risky-preview.test.ts tests/integration/safe-writes.test.ts tests/integration/agentic-chat.test.ts` → all pass (the happy-path confirm/commit behavior is unchanged).
- `npm run verify` → exit 0.

## Test plan

- New test (in `tests/integration/`): "a throwing post-commit bookkeeping write
  does not 500 the confirm and still returns the committed receipt; the commit
  ran exactly once." Pattern source: `tests/integration/risky-preview.test.ts`.
- Optional second case: `setConfirmationResult` throws (same expectation) — to
  cover both writes.
- Regression: the existing confirm-flow tests still pass (happy path unchanged).

## Done criteria

ALL must hold:

- [ ] New integration test exists and passes; it fails when the try/catch is
      removed (confirm by temporarily reverting Step 2 if unsure).
- [ ] The change is confined to the post-commit tail of `commitConfirmation`;
      nothing above `setConfirmationResult` is modified.
- [ ] `npm run verify` exits 0.
- [ ] `git status` shows only the in-scope files changed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- Making the test fail requires changing anything ABOVE the excerpt (the one-use
  claim / policy re-check) — it should not; the failure is purely the
  un-isolated tail.
- You cannot inject a throwing store method through the existing test harness
  without changing production code — STOP and report; do not add a test-only
  hook to `src/`.
- The happy-path confirm tests change behavior (e.g. a receipt field differs)
  after your change — that means the try/catch altered control flow; STOP.

## Maintenance notes

- This makes the audit trail best-effort-but-logged. If you later want a
  stronger guarantee (audit write inside the same transaction as the commit),
  that's a larger change in `commitConfirmedOperation`/the store — out of scope
  here and explicitly deferred.
- Reviewer: confirm the commit, one-use claim, and policy re-check are byte-for-
  byte unchanged, and that the catch logs the message only (no `error` object,
  no `receipt`, no headers).
