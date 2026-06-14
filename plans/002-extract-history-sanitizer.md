# Plan 002: Extract the history-sanitizer/preview-text helpers out of `api.ts` into their own module

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7826299..HEAD -- src/routes/api.ts tests/unit/history-sanitizer.test.ts`
> If either changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (do before plan 005 — this is its first, safe slice)
- **Category**: tech-debt
- **Planned at**: commit `7826299`, 2026-06-14

## Why this matters

`src/routes/api.ts` is 1394 lines — an order of magnitude above the repo median
— and violates the team's stated value ("small files, one responsibility").
This plan carves out one cohesive, **pure** unit: the history-sanitizer and
truthful-preview text helpers. These functions are safety-relevant (they decide
what is rewritten/dropped from the model-visible chat history — pinned by the
comment "safety-invariants-02"), already exported, and **already unit-tested** in
a file literally named `tests/unit/history-sanitizer.test.ts`. Moving them into
`src/routes/history-sanitizer.ts` makes that boundary explicit and navigable
without changing any behavior. It is a pure move; the compiler and the existing
tests are the safety net.

## Current state

- `src/routes/api.ts` — contains these top-level, **pure** declarations (no
  closure over router/`deps` state; they use only `Buffer`/`RegExp`/string
  ops). They form one cohesive group ("how chat history is sanitized for the
  model + the truthful-preview reply text"):
  - `HISTORY_RESULT_MAX_BYTES` (const, line ~93)
  - `pruneHistoryResult(result)` (exported, line ~103)
  - `previewReplyText(count)` (exported, line ~136)
  - `failureReplyText(failed, total)` (exported, line ~152)
  - `failedAttemptNote(failed)` (exported, line ~170)
  - `escapeRegExp(literal)` (helper, line ~176)
  - `PREVIEW_BOILERPLATE` (const, line ~188 — DERIVED from `previewReplyText`
    via the IIFE; must move together with it and `escapeRegExp`)
  - `sanitizeStoredReplyForModel(content)` (exported, line ~198 — uses
    `PREVIEW_BOILERPLATE`)
  - `isTransientErrorMessage(message)` (exported, line ~215)

  Excerpt (the byte-cap function and its constant — confirm you're looking at
  the right code):

  ```ts
  export const HISTORY_RESULT_MAX_BYTES = 24_000;

  export function pruneHistoryResult(result: unknown): unknown {
    if (!result || typeof result !== "object") return result;
    const item = result as { kind?: string; receipt?: unknown };
    if (item.kind !== "receipt" || !item.receipt || typeof item.receipt !== "object") return result;
    const full = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (full <= HISTORY_RESULT_MAX_BYTES) return result;
    // … drops the bulky `data` blob with an honest note …
  }
  ```

- `tests/unit/history-sanitizer.test.ts` — already imports four of these names
  **from `api.ts`** (this import line is what you will repoint in Step 3):

  ```ts
  import {
    HISTORY_RESULT_MAX_BYTES,
    previewReplyText,
    pruneHistoryResult,
    sanitizeStoredReplyForModel,
  } from "../../src/routes/api.js";
  ```

- `tests/integration/agentic-chat.test.ts` also imports `previewReplyText` and
  `sanitizeStoredReplyForModel` **from `api.ts`** (line ~11). It must keep
  working — so `api.ts` will RE-EXPORT the moved names (see Step 2). Do NOT edit
  that test.

- Convention: this is an ESM project — every relative import ends in `.js`
  (e.g. `from "./history-sanitizer.js"`). Match it.

## Commands you will need

| Purpose        | Command                                             | Expected            |
|----------------|-----------------------------------------------------|---------------------|
| Typecheck      | `npm run type-check`                                | exit 0, no errors   |
| The unit test  | `npx vitest run tests/unit/history-sanitizer.test.ts` | all pass          |
| The integ test | `npx vitest run tests/integration/agentic-chat.test.ts` | all pass        |
| Cycles         | `npm run cycles`                                    | "✔ No circular dependency found!" |
| Full gate      | `npm run verify`                                    | exit 0              |

## Scope

**In scope** (the only files you may modify/create):
- `src/routes/history-sanitizer.ts` (CREATE)
- `src/routes/api.ts` (remove the moved declarations; add an import + re-export)
- `tests/unit/history-sanitizer.test.ts` (repoint its import — Step 3)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- `tests/integration/agentic-chat.test.ts` — must keep importing from `api.ts`;
  the re-export in Step 2 is what keeps it green. Touching it widens the blast
  radius unnecessarily.
- The typed-consent guard (`CONSENT_*`, `TYPED_CONSENT`, `BARE_AFFIRMATIVE`,
  `lastTurnCompletedAWrite`, ~lines 247-320) — a DIFFERENT concern; leave it in
  `api.ts` (plan 005 may extract it separately).
- `sanitizeResultsForHistory` (defined inside `apiRouter`, ~line 1135) — leave
  it; it stays where it is for this plan.
- Any behavior change to the moved functions — this is a byte-for-byte move.

## Git workflow

- Branch `advisor/002-history-sanitizer`, or direct-commit per your workflow.
  Do NOT push/PR unless instructed.
- One commit; message e.g. `refactor(routes): extract history-sanitizer helpers from api.ts`.

## Steps

### Step 1: Create `src/routes/history-sanitizer.ts` with the moved code

Create the new file and MOVE (cut, don't copy) the nine declarations listed in
"Current state" into it, **preserving their doc comments verbatim** (the
comments carry safety rationale like "safety-invariants-02" and
"r2-new-session-restore-06"). Keep `export` on the ones that were exported; keep
`escapeRegExp`, `PREVIEW_BOILERPLATE`, and the `HISTORY_RESULT_MAX_BYTES` const
module-private/exported exactly as they were (`HISTORY_RESULT_MAX_BYTES` and the
four functions named in the test import MUST remain `export`).

The new file must NOT import anything from `./api.js` (that would create a
cycle). It needs no imports beyond Node's `Buffer` global (already ambient).

**Verify**: `npm run type-check` will fail here (api.ts still references the
moved names) — that's expected; proceed to Step 2.

### Step 2: Update `api.ts` to import the moved names and re-export the public ones

In `src/routes/api.ts`, after removing the moved declarations:

1. Add an import for every moved name that `api.ts` still uses internally:
   ```ts
   import {
     HISTORY_RESULT_MAX_BYTES,
     pruneHistoryResult,
     previewReplyText,
     failureReplyText,
     failedAttemptNote,
     PREVIEW_BOILERPLATE,
     sanitizeStoredReplyForModel,
     isTransientErrorMessage,
   } from "./history-sanitizer.js";
   ```
   (Include only the names `api.ts` actually references — let the compiler tell
   you which are unused and trim them.)

2. Re-export the names that OTHER modules/tests import from `api.ts`, so their
   imports keep resolving (`agentic-chat.test.ts` needs `previewReplyText` +
   `sanitizeStoredReplyForModel`; keep the others that were public):
   ```ts
   export {
     HISTORY_RESULT_MAX_BYTES,
     pruneHistoryResult,
     previewReplyText,
     failureReplyText,
     failedAttemptNote,
     sanitizeStoredReplyForModel,
     isTransientErrorMessage,
   } from "./history-sanitizer.js";
   ```

**Verify**: `npm run type-check` → exit 0, no errors.

### Step 3: Repoint the unit test at the new module

In `tests/unit/history-sanitizer.test.ts`, change the import source from
`"../../src/routes/api.js"` to `"../../src/routes/history-sanitizer.js"` (the
imported names are unchanged). This makes the test import directly from the unit
it covers.

**Verify**: `npx vitest run tests/unit/history-sanitizer.test.ts` → all pass.

### Step 4: Full verification

**Verify**:
- `npx vitest run tests/integration/agentic-chat.test.ts` → all pass (proves the
  re-export keeps the integration importer green).
- `npm run cycles` → "✔ No circular dependency found!" (proves no import cycle).
- `npm run verify` → exit 0.

## Test plan

- No new test logic. The existing `tests/unit/history-sanitizer.test.ts` (now
  importing from the new module) and `tests/integration/agentic-chat.test.ts`
  (via the re-export) are the full regression guard.
- Verification: both test files pass; `npm run verify` exits 0; `npm run cycles`
  reports zero cycles.

## Done criteria

ALL must hold:

- [ ] `src/routes/history-sanitizer.ts` exists and contains the nine moved
      declarations with their original doc comments.
- [ ] `grep -nE "export function pruneHistoryResult|export function previewReplyText" src/routes/api.ts`
      returns NO matches (the definitions moved out of api.ts).
- [ ] `tests/unit/history-sanitizer.test.ts` imports from
      `../../src/routes/history-sanitizer.js`.
- [ ] `npm run verify` exits 0; `npm run cycles` reports zero cycles.
- [ ] `git status` shows only the in-scope files changed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- Moving `PREVIEW_BOILERPLATE`/`sanitizeStoredReplyForModel` reveals they
  reference router/`deps` state (they should not — they're pure). If a moved
  symbol needs something from inside `apiRouter`, STOP; it's not part of this
  pure unit.
- `npm run cycles` reports a cycle after the move (the new module must not import
  from `api.ts`).
- The "Current state" excerpts don't match the live code (api.ts drifted).
- Any test outside the two named files fails — that means a name you removed was
  imported somewhere unlisted; STOP and report which importer broke.

## Maintenance notes

- This is the **safe first slice of plan 005** (decompose `api.ts`). The same
  re-export-then-repoint pattern applies to the next extractions (the consent
  guard, the request schemas, the async handler).
- The re-exports in `api.ts` are a temporary compatibility shim. A follow-up
  (part of plan 005) can repoint `agentic-chat.test.ts` directly at the new
  module and drop the re-exports — out of scope here to keep this plan minimal.
- Reviewer: confirm the diff is a pure move (no logic changes inside the moved
  functions) and that no cycle was introduced.
