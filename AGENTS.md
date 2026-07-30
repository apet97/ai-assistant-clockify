# AGENTS.md — AI Assistant Add-on execution router

Use this file to choose the right lane and gate. Engineering truth:
[`CLAUDE.md`](./CLAUDE.md); release operations: [`DEPLOYMENT.md`](./DEPLOYMENT.md);
evidence history: [`MARKETPLACE_READINESS.md`](./MARKETPLACE_READINESS.md) and
[`docs/marketplace/`](./docs/marketplace/). Do not duplicate them here.

## Current checkpoint — 2026-07-31

- **Deployed:** immutable Railway cutover `ad06c08`, explicitly
  `ASSISTANT_ENGINE=v2`, schema 13 at `/data/ai-assistant-v2.sqlite`. The retained
  v1 database/tree is rollback history; see [`the cutover record`](./docs/V2_CUTOVER_RECORD.md).
- The cutover record correctly preserves the initial fresh-database `409` state;
  current production has a fresh v2 installation/attestation (generation 1),
  installed at `2026-07-30T02:47:41Z` according to the aliased lifecycle log.
- **Source boundary:** Phase A, the Phase B evidence scaffolding, and M1–M7 are
  present through immutable Phase M boundary `0b2b723`; descendants do not
  change it. Refresh remote/check status in preflight.
- **Landing rule:** Phase M is landed iff protected remote `main` contains
  `0b2b723` and the exact current candidate's required checks are green. Only then
  may an operator enter `phase-m-landed` in the paid eval workflow.
- **Evidence is structurally blocked:** `eval:write-safety` emits only the blocked
  accounting report; its observer is test-only, authority ignores observations,
  and `release-evidence.yml` lacks an all-gates exact-SHA v2 conclusion.

## Preflight every task

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node --version                         # must be v22.x
git status --short
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count origin/main...HEAD
```

Preserve inherited changes. Do not clean, reset, stash, stage, commit, push, or
publish work you do not own; resolve overlapping dirty work before editing.

## Choose the lane

| Change | Read first | Minimum proof |
|---|---|---|
| Product/runtime code | `CLAUDE.md` safety + architecture | focused tests, both type-checks, lint; `verify` before handoff |
| Clockify wire behavior | `CLAUDE.md` API facts | official OpenAPI + sacrificial probe + adapter/contract tests |
| Browser/UI | `README.md`, relevant `src/ui/` contracts | focused tests + `test:e2e:real` |
| v2 runner/services | ADR 001 + `src/assistant-v2/` + `src/services/` | focused v2 composition/contract tests |
| Eval/evidence | `scripts/eval-v2/`, evidence builders, workflows | deterministic contract tests; never invent missing evidence |
| Release/deploy | `DEPLOYMENT.md` literally | clean exact candidate + backup/evidence gates + explicit authority |

## Irreducible safety rules

[`ADR 001`](./docs/adr/001-api-agent-v2.md) governs the v2 rewrite.
During coexistence, v1 accepts only critical safety, production, and verified Clockify-contract fixes.

1. Admin/owner authority is checked before session creation and freshly before
   every write, confirmation, undo, and each primary or compensation mutation
   dispatch.
2. The model proposes actions only. The deterministic registry/harness owns
   schema, policy, risk, capability, confirmation, dispatch, and settlement.
3. Risky writes and every edit of existing data require stored preview plus
   button-only confirmation. Typed consent never executes a write.
4. Clockify writes are exact-plan, step-journaled, single-flight, and never
   auto-retried after dispatch. Ambiguous outcomes stop later effects.
5. `src/clockify/rest/core.ts` must reject every mutation outside its async-local
   durable step scope. Never weaken this to make a probe pass.
6. Resolve names/ids/dates server-side at preview time. Truncated lists cannot
   prove absence or uniqueness.
7. Real/live tokens, raw auth headers, plaintext confirmation nonces, and provider
   keys never enter prompts, logs, commits, screenshots, or evidence. Bounded
   Clockify tool results may be model-visible; raw/unbounded payloads and auth
   material may not. Tests use unmistakably fake values.
8. Live work uses a sacrificial workspace, explicit credentials/authorization,
   bounded cleanup, and a final zero-leftover sweep.
9. No bare `railway up`, mutable-tree deploy, production write, paid model run,
   Marketplace submission, or rollback-state change without explicit authority.
10. Treat checked-in evidence as typed input, not a conclusion. Bind every claim
    to the exact source candidate, catalog, engine, deployment, and required gate.

## Essential commands

Credential-free local gates:

```bash
npm ci
npm run type-check
npm run type-check:scripts
npm run check:api-action-inventory
npm test
npm run test:e2e:real               # local real Express/SQLite/browser path
npm run verify                      # full local handoff gate; run in isolation
```

Eval lanes:

```bash
npm run eval:smoke                  # offline, deterministic, no credentials
npm run eval:write-safety           # credential-free BLOCKED accounting entrypoint; exit 2
npm run eval:api-discovery          # CREDENTIALED + PAID: 1,080 agent turns
npm run eval:assistant-terminal     # CREDENTIALED + PAID: 897 attempts
```

Live lanes — sacrificial workspace only:

```bash
npm run live:v2-full -- --dry-run   # no real Clockify writes
npm run live:v2-full                # LIVE WRITES; guarded env + per-step authorization
npm run live:sweep                  # LIVE cleanup; must finish at 0 leftovers
npx tsx scripts/live-full.ts        # LIVE diagnostic: reads/previews/sweep only
```

`live:v2-full` is the sole v2 live-write evidence path. `live-full.ts` bypasses
the durable v2 write composition; its write failures are expected fail-closed
diagnostics and its write columns are not evidence.

Evidence/deploy lanes:

```bash
npm run record:v2-release-evidence  # partial v2 builder; not an all-gates conclusion
npm run gate:predeploy-backup       # credentialed candidate-bound backup gate
npm run deploy:private-production   # EXTERNAL + GUARDED release transaction
```

The record command validates inputs; it does not create missing paid, live,
deployment, browser, or human evidence. Deploy only from `DEPLOYMENT.md`.

## Evidence boundary

- Existing DeepSeek, private-production, browser, and aggregate release records
  are immutable **historical v1** evidence and remain valid only for rollback.
- The v2 lane is structurally blocked at the write-safety observation/authority
  handoff and exact-SHA all-gates aggregation. Do not treat its current artifacts
  as release evidence.
- Remaining order: fix the post-M evidence handoff, complete C/D work, then run a
  candidate-bound release. Live write/cleanup, deployment/browser proof, soak,
  independent sign-off, and Marketplace access remain external/technical gates.
- M1–M7 now grade the real runner: 120 add-on-loadable cases × three cohorts ×
  three repeats = 1,080 attempts; per case the floors are canonical 3/3,
  paraphrase at least 2/3, typo at least 2/3; unrelated destructive calls and
  more than 12 loaded API tools are zero-tolerance. The `ad06c08` 239/1,143
  diagnostic cannot select a model.

## Current v2 map

- `src/assistant-v2/` — protocol/state, budgets, discovery, read execution,
  references, observations/events, runner, prompt, presentation.
- `src/services/` — production orchestration for runs, discovery, preparation,
  execution, confirmations, clarification, results, history, events, metrics,
  permissions, sessions, artifacts, and undo.
- `src/clockify/rest/core.ts` — live I/O and async-local mutation-scope refusal.
- `scripts/eval-v2/` + `scripts/eval-{api-discovery,assistant-terminal,write-safety}.ts`
  — corpus, policy, harness, report, and three v2 eval entrypoints.
- `scripts/live-v2-full.ts` — guarded preview/confirm/live-write/cleanup chain;
  `scripts/live-full.ts` is read/preview/sweep diagnostic only.
- `scripts/evidence/v2-*.ts` — v2 authority, aggregate, model, deployment, and
  browser evidence builders/validators.
- `.github/workflows/v2-model-evals.yml` + `.github/workflows/release-evidence.yml` — not yet a connected all-gates v2 lane.
