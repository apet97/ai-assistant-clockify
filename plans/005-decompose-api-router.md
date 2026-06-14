# Plan 005: Incrementally decompose the 1394-line `api.ts` god-file into cohesive modules

> **Executor instructions**: This plan is PHASED and STOP-FRIENDLY. Do the
> phases in order; each phase is one or more self-contained commits that leave
> the tree fully green. **Phase 1 alone is a complete, valuable deliverable** —
> you may stop after it and report. Phase 2 is higher-risk; do it only if
> explicitly asked, one route-group per commit, each reviewed. Never let any
> single commit leave `npm run verify` or `npm run cycles` red. If anything in
> "STOP conditions" occurs, stop and report. Update `plans/README.md` after each
> phase.
>
> **Drift check (run first)**: `git diff --stat 7826299..HEAD -- src/routes/api.ts`
> If `api.ts` changed materially since this plan was written, re-derive the line
> ranges below from the live file (use the symbol names, not the numbers) before
> proceeding.

## Status

- **Priority**: P3
- **Effort**: M (Phase 1) / L (Phase 2)
- **Risk**: LOW (Phase 1, pure moves) / MED–HIGH (Phase 2, stateful route groups)
- **Depends on**: plan 002 (it extracts the first module — the history sanitizer)
- **Category**: tech-debt
- **Planned at**: commit `7826299`, 2026-06-14

## Why this matters

`src/routes/api.ts` is 1394 lines — roughly 10× the repo median and the largest
file in the codebase. It tangles ~six responsibilities: request schemas, the
typed-consent guard, history sanitization, the turn pipeline (chat), the
confirm/resume engine, and the route wiring. This violates the team's explicit
value ("small files, one responsibility") and makes the file hard for both
humans and AI executors to navigate and review — every change to confirmation
logic happens in a file that's 80% chat-pipeline. This plan decomposes it
**incrementally and behavior-preservingly**, starting with the pure, zero-risk
utility moves (Phase 1) and leaving the entangled, stateful route groups (Phase
2) as an optional, carefully-staged follow-up. The 1224-test suite + the
zero-cycles invariant are the safety net at every step.

## Current state

`src/routes/api.ts` contains (line numbers approximate — use the symbol names):

**Module-level, PURE (no closure over `deps`/router) — Phase 1 candidates:**
- Request schemas: `groupsPatchSchema` (~51), `chatBodySchema` (~61),
  `confirmBodySchema` (~62)
- History sanitizer group (`pruneHistoryResult`, `previewReplyText`,
  `failureReplyText`, `failedAttemptNote`, `escapeRegExp`, `PREVIEW_BOILERPLATE`,
  `sanitizeStoredReplyForModel`, `isTransientErrorMessage`,
  `HISTORY_RESULT_MAX_BYTES`, ~93-222) — **EXTRACTED BY PLAN 002** into
  `src/routes/history-sanitizer.ts`. Treat as done; do not re-extract.
- Typed-consent guard: `CONSENT_AFFIRMATION` (~247), `CONSENT_FILLER` (~253),
  `CONSENT_APPLY_VERB` (~255), `CONSENT_PENDING_OBJECT` (~257), `TYPED_CONSENT`
  (~259), `BARE_AFFIRMATIVE` (~287), `lastTurnCompletedAWrite` (~304)
- `asyncHandler` (~321)

**Inside `apiRouter(deps)` (~329) — closures over `deps`/helpers (Phase 2):**
- Helpers: `loadPolicy` (~339), `requireSession` (~343), `actionContext` (~352),
  `recordUndoIfReversible` (~372), `createTurnMachinery` (~412),
  `settleAgentTurn` (~495), `truthfulReplyText` (~525), `redactNonceForStorage`
  (~569), `storedContentForReply` (~596), `persistAssistantReply` (~605),
  `recordTurnTelemetrySafely` (~617), `runResume` (~648), `commitConfirmation`
  (~708), `executeChatTurn` (~920), `chatPreconditions` (~1098),
  `sanitizeResultsForHistory` (~1135)
- Routes: `/me` (~810), `/metrics` (~829), `/permissions` (~851),
  `/permissions/preview` (~863), `/permissions/confirm` (~880), `/chat/history`
  (~1155), `/chat/new` (~1198), `/chat/messages` (~1224), `/chat/stream`
  (~1236), `/confirmations/:id/confirm` (~1262), `/undo/:id` (~1325),
  `/confirmations/:id/cancel` (~1373)

Conventions: ESM (`.js` suffixes); Conventional Commits; one focused commit per
unit; `madge` must report 0 cycles; no behavior changes in a refactor.

## Commands you will need

| Purpose   | Command            | Expected                          |
|-----------|--------------------|-----------------------------------|
| Typecheck | `npm run type-check` | exit 0                          |
| Tests     | `npm test`         | all 1224 pass                     |
| Cycles    | `npm run cycles`   | "✔ No circular dependency found!" |
| Full gate | `npm run verify`   | exit 0                            |

## Scope

**In scope**: `src/routes/api.ts` and new sibling modules under `src/routes/`;
the test import lines that point at moved symbols; `plans/README.md`.

**Out of scope** (hard rules):
- ANY behavior change. This is structural only. If a move would require changing
  logic, STOP.
- The harness (`src/harness/*`), the store, the clockify adapter — untouched.
- Raising/lowering any limit, timeout, or guard.
- New modules must NEVER import from `./api.js` (that creates a cycle). They take
  what they need as function parameters or import shared TYPES from
  `./deps.js` / the harness.

## Git workflow

- Branch `advisor/005-decompose-api` (or per your workflow). Do NOT push/PR
  unless instructed.
- **One commit per extracted module.** Message style:
  `refactor(routes): extract <thing> from api.ts`.
- Run `npm run verify && npm run cycles` before EACH commit.

## Steps

### Phase 1 — pure module-level extractions (LOW risk; each its own commit)

For each sub-step: create the new file, MOVE the symbols (with their doc
comments), add an `import { … } from "./<new>.js"` in `api.ts` for internal use,
and a re-export (`export { … } from "./<new>.js"`) for any symbol imported
elsewhere (grep `grep -rn "<symbol>" tests src` to find external importers).
The new file must not import from `./api.js`.

#### Step 1.1: `src/routes/request-schemas.ts`
Move `groupsPatchSchema`, `chatBodySchema`, `confirmBodySchema`. They use only
`zod`. **Verify**: `npm run verify && npm run cycles` green → commit.

#### Step 1.2: `src/routes/consent-guard.ts`
Move the typed-consent group: `CONSENT_AFFIRMATION`, `CONSENT_FILLER`,
`CONSENT_APPLY_VERB`, `CONSENT_PENDING_OBJECT`, `TYPED_CONSENT`,
`BARE_AFFIRMATIVE`, and `lastTurnCompletedAWrite`. These are pure (regex +
a pure predicate). First grep to confirm none close over `deps`. **Verify**:
`npm run verify && npm run cycles` green → commit.

#### Step 1.3: `src/routes/async-handler.ts`
Move `asyncHandler`. Pure higher-order wrapper. **Verify**: green → commit.

After Phase 1, `api.ts` is ~150–250 lines lighter and the pure utilities are
isolated and independently testable. **You may STOP here and report** — this is
a complete, low-risk improvement.

### Phase 2 — stateful route-group extractions (OPTIONAL; MED–HIGH risk)

Only proceed if explicitly asked. These groups close over `deps` and shared
helpers, so the technique is a **shared router context** created once in
`apiRouter` and passed to each group factory. Do the LEAST-coupled group first.

#### Step 2.0: Introduce a `RouterContext`
In `apiRouter`, after building the helpers, assemble a single object, e.g.:
```ts
const ctx = { deps, now, loadPolicy, requireSession, actionContext, /* … */ };
```
Define its type in a small `src/routes/router-context.ts` (TYPES only — no logic,
no import from api.ts). This is the seam every group factory consumes.
**Verify**: green → commit (no routes moved yet, just the context object).

#### Step 2.1: `src/routes/permissions-routes.ts` (least coupled — do first)
Extract `/permissions`, `/permissions/preview`, `/permissions/confirm` into
`createPermissionsRoutes(ctx): Router` and mount it in `apiRouter`
(`router.use(createPermissionsRoutes(ctx))`). **Verify**: the permissions tests
pass; `npm run verify && npm run cycles` green → commit.

#### Step 2.2: `src/routes/misc-routes.ts`
Extract `/me` and `/metrics` the same way. **Verify**: green → commit.

#### Step 2.3: the chat + confirm/resume engine (HIGHEST risk — land last, carefully)
This is the entangled core: `runResume` bridges `/chat/stream` and
`/confirmations/:id/confirm`, and the turn pipeline (`executeChatTurn`,
`createTurnMachinery`, `settleAgentTurn`, `truthfulReplyText`,
`persistAssistantReply`, `recordTurnTelemetrySafely`) is shared. Recommended
seam:
- `src/routes/turn-engine.ts`: the turn pipeline + `runResume` + `commitConfirmation`
  + `recordUndoIfReversible`, exposed as a factory `createTurnEngine(ctx)`
  returning the functions the routes call.
- `src/routes/chat-routes.ts`: `createChatRoutes(ctx, engine)` — `/chat/*`.
- `src/routes/confirmation-routes.ts`: `createConfirmationRoutes(ctx, engine)` —
  `/confirmations/:id/confirm`, `/undo/:id`, `/confirmations/:id/cancel`.
Do this as MULTIPLE commits (engine first, then each route file), verifying green
between each. If the shared closures prove too entangled to separate cleanly
without behavior risk, STOP and report — a partial Phase 2 (2.1 + 2.2 done, 2.3
deferred) is an acceptable end state.

## Test plan

- No new test logic — this is a behavior-preserving refactor. The existing 1224
  tests are the regression guard, run in full after EVERY commit.
- Any test importing a moved symbol from `../../src/routes/api.js` keeps working
  via the re-export, or is repointed at the new module in the same commit.
- Verification after each commit: `npm run verify` exits 0 AND `npm run cycles`
  reports zero cycles.

## Done criteria

Phase 1 (minimum):
- [ ] `src/routes/request-schemas.ts`, `consent-guard.ts`, `async-handler.ts`
      exist; their symbols no longer DEFINED in `api.ts` (grep each name +
      `function`/`const` in api.ts → no definition, only import/re-export).
- [ ] `wc -l src/routes/api.ts` is meaningfully smaller than 1394.
- [ ] `npm run verify` exits 0; `npm run cycles` zero cycles; all 1224 tests pass.
- [ ] `plans/README.md` status row updated.

Phase 2 (if attempted): each extracted route group is in its own file mounted
via `router.use(...)`, all tests green, zero cycles, and `api.ts`'s `apiRouter`
is reduced to context assembly + `router.use(...)` mounts.

## STOP conditions

Stop and report (do not improvise) if:

- A symbol you planned to move turns out to close over router/`deps` state that
  Phase 1 assumed was pure — leave it for Phase 2; don't force it.
- `npm run cycles` reports a cycle after any move (a new module imported back
  from `api.ts`, or two new modules formed a loop). Revert that commit and
  report.
- Any of the 1224 tests changes behavior (not just import path) — a refactor
  must not alter outcomes.
- In Phase 2.3, separating `runResume`/the turn pipeline cleanly would require
  changing control flow or duplicating logic — STOP; deliver 2.1/2.2 and defer
  2.3.

## Maintenance notes

- Order matters: Phase 1 (pure moves) is safe and high-leverage; Phase 2.3 (the
  chat/confirm engine) is the risky core — it's deliberately last and optional.
- The re-export shims in `api.ts` (added during moves) can be removed in a
  later pass once external importers are repointed at the new modules; left in
  place they're harmless.
- Reviewer: for every commit, confirm the diff is a pure move/mount (no logic
  edits) and `npm run cycles` is green. Scrutinize Phase 2.3 hardest — it
  touches the confirm/resume safety path; verify the one-use claim, policy
  re-check, and resume ordering are byte-for-byte unchanged.
- This plan pairs with the team's "small files, one responsibility" value; after
  it lands, no file in `src/routes/` should approach four digits of LOC.
