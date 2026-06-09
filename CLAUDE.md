# CLAUDE.md — AI Assistant Add-on

Read this first in every Claude Code session.

## Handoff note (start here if you're taking over) — 2026-06-09 (agentic loop)

**Where this stands:** the **durable approval-gated agentic loop is SHIPPED and is now
the default** (`LLM_AGENTIC` defaults ON; `=0` is the instant rollback). This was the one
remaining architectural gap — the chat planner was single-turn and could not read-then-act
(e.g. *list clients → create an invoice for "qwen"*). It now can. `npm run verify` is green
at **668 tests** (type-check + Vitest + build), 0 circular deps; everything is committed +
pushed to `main`. Built TDD, Phases 2b→5, each `npm run verify`-green with a focused commit:

- **The loop** (`src/assistant/agent-loop.ts`, wired in `da76cfc`): reads + safe writes
  auto-chain (their receipts are fed back to the model and it re-plans); the FIRST risky
  write **interrupts** into the existing preview→button-confirm flow. `runAgentConversation`
  (`src/assistant/planner.ts`) is the entry; `createTurnMachinery` in `src/routes/api.ts`
  is the single copy of the audit+undo receipt emitter / preview creator / harness
  `runAction` shared by the agentic + single-turn branches.
- **Durable resume** (`b244884`): on a risky interrupt the suspended transcript is persisted
  to a new additive `pending_confirmations.agent_state_json` column (`addColumnIfMissing`;
  NULL rows behave exactly as before). `POST /confirmations/:id/confirm` — after the
  UNCHANGED nonce / policy-recheck / one-use-claim / `commitConfirmedOperation` pipeline —
  feeds the committed receipt back as the risky call's tool result and re-enters the loop
  (`src/assistant/agent-state.ts`, Zod-validated; malformed → no resume). The resumed loop
  can chain ANOTHER preview, never commit inline.
- **DeepSeek `reasoning_content` contract (`c45bfdc`):** v4 thinking mode returns
  `reasoning_content` and REQUIRES it back verbatim on continuation (400 otherwise). The
  eval caught this. `ModelMessage`/`ToolCompletion` carry `reasoningContent`, threaded
  through the loop + the persisted state + `toWireMessage`; turns without it serialize
  byte-identically.
- **Proof:** `scripts/eval-agentic.ts` (real model + real harness vs fake) measured
  **agentic 90.5% vs single-turn 57.1% task completion** (deepseek-v4-pro, repeat=3;
  read-then-act 0/9→8/9; **0 safety violations**). A 3-subagent adversarial safety review
  found **every invariant HELD, 0 BROKEN**. `scripts/live-agentic-flow.ts` proved it on a
  **real Clockify host + real DeepSeek + real commit + resume, PASS=10 FAIL=0** (the
  "create an invoice for qwen" acceptance flow, minus the literal browser-iframe click).
- **Rollback:** `LLM_AGENTIC=0` → byte-identical single-turn (pinned by test). The live dev
  server was restarted (tunnel URL unchanged) so the embedded install runs the loop now.

The only remaining manual step is the human's literal browser-iframe acceptance click; the
over-HTTP path (incl. resume) is covered by `tests/integration/agentic-chat.test.ts` and the
over-model/over-host substance by the live script. Plan/status:
`/Users/15x/Downloads/ai-assistant-agentic-loop-GOAL.md`.

**Post-flip live fixes (2026-06-10, dogfooding found these — all fixed + verified, `npm run
verify` now = 683 tests):**
- **Streaming confirm (`1a60305`):** the resume ran synchronously *inside* the confirm
  request (multiple live model calls) → the Confirm button blocked 7.5s+ and a slow resume
  timed out as "Confirmation failed" even though the write committed. Now `POST
  /confirmations/:id/confirm?stream=1` (the embedded UI uses it) flushes the committed
  receipt as the FIRST NDJSON event (~+520ms) then streams the resume; the JSON path is
  unchanged for scripts/tests. UI: `submitConfirmStream` in `src/ui/shared.ts`.
- **Approvals periodStart (`784a085`):** `clockify_approvals_submit` sent a bare date;
  Clockify needs a full ISO UTC instant. Now takes a relative `week` ('this_week'/'last_week')
  resolved server-side from `ctx.now`, or normalizes an explicit date. Live-verified.
- **Invoice item types (`f4632b8`, `fd269e6`):** types are **per-workspace configured NAMES**
  with NO list/create API — but they're auto-created when a line item is added in the Clockify
  invoice editor, and every stored line item carries its `itemType` name. So the harness now
  **discovers** valid names from existing invoices (`discoverItemTypes`) and resolves the
  requested/omitted type against them (canonical match / clarify-with-real-list / first-as-
  default), instead of blindly sending "NEW DEFAULT". Wired into `items_add` + `create` inline
  items. See the verification discipline below — this whole class of bug came from trusting the
  code's API assumptions instead of the real API.

---

## Ground truth & verification discipline (READ THIS)

This codebase was built fast ("vibecoded") and **its assumptions about the Clockify API have
repeatedly been wrong** — invoice item types, date/instant formats, list-vs-envelope shapes,
which host serves what. Every such bug was found by hitting the **real API**, not by reading
the code. So, before trusting or extending any Clockify-touching code:

1. **The OpenAPI spec is ground truth:** `https://docs.clockify.me/openapi.json` (live, 200).
   Check the real request/response shape there before believing a comment or a Zod schema.
2. **Sibling references** (read-only — do **not** modify): `../goclmcp` (Go MCP over the same
   API; `docs/openapi`, `scripts/gen-clockify-openapi`) and `../clockify-ts-sdk` (a typed TS
   SDK + CLI + MCP). When the addon's adapter and these disagree, the addon is usually the one
   that's wrong.
3. **Verify live, don't assume:** the opt-in scripts hit a sacrificial workspace via API key
   **or** the install's `X-Addon-Token`. For anything new or surprising, write a throwaway
   probe (delete it after) — that's how the item-type/format truths above were settled. The
   per-workspace, no-list-API nature of invoice item types was only knowable by probing ~30
   workspaces live.
4. **TDD against the verified shape:** once the real shape is known, pin it with a failing
   test first, then the fix. Never "fix" a live-API bug without a test reproducing it.

---

## Earlier handoff note — 2026-06-09 (trust-lives-in-the-code roadmap)

**Where this stands:** V1 + the full Clockify REST parity effort are complete, AND the
entire **"trust lives in the code" roadmap (`NEXT_SESSION_PLAN.md`, Phases 1–7) is
delivered** for everything buildable in-repo. `npm run verify` is green at **624 tests**
(type-check + Vitest + build); everything is committed and pushed to `main`. Across this
arc the suite went 479 → 618, then a thermo-nuclear codebase-review refactor took it to
**624** (see "Structural refactor" below).

**What got built (all on `main`, each TDD'd, see "Current Status" for detail):**
- **Phase 1** — a planner **eval harness** (`scripts/eval-planner.ts`, pure scorer
  `src/eval/score.ts`) that reports pass-rate **and** a consistency metric; the argument
  contract in the prompt (`src/harness/arg-summary.ts`).
- **Phase 2** — **native tool-calling is the default** (`LLM_MODE=tool`,
  `zod-to-json-schema`, `src/harness/tools.ts`): the provider validates args; the
  arg-shape-guessing class is eliminated. Measured 95.2% pass vs 88.9% JSON.
- **Phase 3** — atomic multi-step **composition** (`src/harness/compose.ts`): no orphans.
- **Phase 4** — grounding: invoice **$0 caveat surfaced in the preview**; clarifies offer
  grounded options (`resolve.suggestOptions`).
- **Phase 5** — **idempotency** (`src/harness/idempotency.ts`, no duplicate invoices) +
  **undo** (`src/harness/undo.ts`, `POST /api/undo/:id`, UI button).
- **Phase 6** — **curated intent actions** (`src/harness/workflows/curated.ts`:
  `clockify_period_report`, `clockify_onboard_user`); adopted 12/12 in the eval.
- **Phase 7 (in-repo slices)** — operational **metrics** (`GET /api/metrics`,
  `src/metrics/metrics.ts`), **UI a11y** + a responsive "working" status, and
  **NDJSON streaming** of the harness's progress (`POST /api/chat/stream`).

**Structural refactor (thermo-nuclear codebase review, 2026-06-09).** A maintainability
pass on the existing code (net ≈−650 lines, **17 → 0 circular dependencies**, 618 → 624
tests), each step `npm run verify`-green:
- **Action builders** (`src/harness/action.ts`): `defineRiskyAction` / `defineReadAction`
  collapse the per-action scaffold — `featureGroup`/`risks`/`actionName` had been restated
  3–4× across 64 risky blocks. All 18 workflow files migrated; the builder derives
  `operation.featureGroup` from `resolveFeatureGroup` so the confirm-time gate keys on the
  correct per-entity group. (Typing rationale is in the action-builder design memory.)
- **Type-only import cycles eliminated (17 → 0)**: shared Clockify summary shapes →
  leaf `src/clockify/types.ts`; `IdempotencyLedger` → `action.ts`; shared UI types →
  `src/ui/shared.ts`. **Keep `npx madge --circular --extensions ts --ts-config tsconfig.json
  src` at 0.**
- **Permission confirms unified**: `ActionContext.savePolicy` lets the permission action's
  `commit` self-persist, so `/confirmations/:id/confirm` routes EVERY op through the single
  `commitConfirmedOperation` choke point (the inline permission special-case is gone; the
  `permission_change` gate-skip is unchanged).
- **Less surface**: the vestigial SDK-wrapper factory is deleted (`createRestWorkspaceClient`
  is the only client path); `rest-workspace.ts` has one HTTP path (`core.call`); `store.ts`
  test-only methods moved to a `TestStore` type; the 966-line `fake-clockify.ts` split into
  per-area `tests/helpers/fake/*`; `mount()` render builders extracted to `src/ui/render.ts`.

**What remains is NOT code you can write alone — it needs the human's decisions / live
credentials:**
1. **Stable hosting** — the dev tunnel URL rotates; a named-tunnel-on-a-domain (Cloudflare
   zone) or a real deploy is an infra/account decision (user declined the zone for now).
2. **Prod security review + token rotation.**
3. **Prod AUDIT-host `X-Addon-Token` clearance** — needs a captured prod token; run
   `scripts/host-auth-spike.ts` with a `LIVE_ADDON_TOKEN` to settle it (dev cleanly
   reports "audit log not available", so this is prod-only).

**To CONTINUE the build:** there's no buildable phase left — the roadmap is done. Good next
work is either the human-gated items above (with the user) or net-new product scope. **To
LIVE-TEST / dogfood:** start from `NEXT_SESSION_PROMPT.md` (it tells you how to bring the
tunnel + install back up). The forward plan + "perfect state" vision live in
`NEXT_SESSION_PLAN.md`. Keep the discipline: failing test first, `npm run verify` green,
focused commits, no new deps without the user's OK, never print/commit tokens.

## Product Contract

AI Assistant is a Clockify add-on with an admin-only chat UI and an internal
MCP-shaped action harness.

- Only Clockify admins and owners can use the chat.
- Each admin has private assistant permissions per workspace.
- Default permissions are full `read_write` for every feature group.
- Admins may change their own permissions inside chat.
- Owners do not view or manage other admins' assistant permissions.
- Safe writes execute immediately and return receipts.
- Risky writes require dry-run preview plus button confirmation.
- `Confirm all` is allowed only for the exact previewed batch.
- Typed confirmation such as "yes" never executes risky actions.
- The model never receives Clockify tokens, add-on tokens, session secrets, model API keys, or raw secret-bearing headers.
- V1 is not a public Claude connector and not a standalone MCP server.

## Branch layout

- **`main` (this branch, curated):** source under `src/`, tests under `tests/`,
  live scripts under `scripts/`, `README.md`, `NEXT_SESSION_PROMPT.md` (the live
  test/continue kickoff — start a new session from there), and this file + `AGENTS.md`.
- **`slopbranch`:** the full design-doc set and project skills/agents
  (`PRD.md`, `SPEC.md`, `TECH_STACK.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`,
  `SAFETY_AND_PERMISSIONS.md`, `IMPLEMENTATION_PLAN*.md`, `TESTING_AND_ACCEPTANCE.md`,
  `API_COVERAGE_PLAN.md`, `REFERENCES.md`, `.claude/`). Read those there
  (`git show slopbranch:SPEC.md`, etc.) when you need the contracts behind the code.

## Engineering Rules

- Keep the implementation simple: TypeScript, Express, vanilla Vite UI, SQLite, Zod, Vitest, Supertest.
- Do not add React, Next.js, Prisma, queues, Redis, vector databases, workers, or multi-agent runtime unless the user explicitly asks.
- Do not modify sibling repos. You may read sibling repos under `/Users/15x/Downloads/WORKING/addons-me`.
- Prefer small files with one responsibility.
- Write the failing test first, then the minimum implementation to pass.
- Run `npm run verify` before claiming any task complete.
- If a safety test fails, stop and fix it before adding features.

## Secret Handling

- Do not log tokens or raw auth headers.
- Do not paste secrets into docs, tests, prompts, commits, or final reports.
- Use fake tokens in tests.
- Live Clockify tests are opt-in only and must use a sacrificial workspace.

## Current Status

V1 is implemented and verified; the **full Clockify REST surface parity
effort (`slopbranch:API_COVERAGE_PLAN.md`, Phases 0–16) is COMPLETE** — ~115
typed catalog actions across 16 feature areas and 3 API hosts, each routed
through the existing safe/risky harness — and the **"trust lives in the code"
roadmap (`NEXT_SESSION_PLAN.md`, Phases 1–7) is COMPLETE for everything buildable
in-repo** (see the Handoff note at the top). The per-phase detail follows below;
the headline is in the Handoff note. `npm run verify` = **624 tests**.

**Live end-to-end PROVEN (2026-06-08):** the add-on was registered + installed on
a sacrificial Clockify dev workspace and driven through the real embedded chat —
install → **sidebar** component → DeepSeek planner → harness → Clockify REST
(dev host, `X-Addon-Token`) → receipt. A tag was created and a detailed report
fetched live. Getting there fixed several real defects (see the auth/host + cookie
notes under "Runtime & Known Constraints"):
  - **Install verification:** the Clockify add-on token-signing **public key is one
    fixed platform key** (published at `{apiUrl}/api/auth/public-key`), now embedded
    as the built-in default (`src/addon/clockify-public-key.ts`); `CLOCKIFY_ADDON_PUBLIC_KEY_PEM`
    is optional. `/lifecycle/installed` requires only `authToken`+`workspaceId`.
  - **UI surface:** the component is a **`sidebar`** entry (not an activity tab) and
    ships an `iconPath` (`/icon.svg`) — a sidebar with no icon doesn't render.
  - **Host resolution:** call the host from the install context, not hardcoded —
    `apiUrl`+`/v1` for the api host, the `reportsUrl` claim+`/v1` for reports
    (`src/clockify/api-base.ts`; captured at component load into `installations.reports_url`).
    The audit host has **no claim** (the only URL claims are
    backendUrl/reportsUrl/locationsUrl/screenshotsUrl/ptoUrl) and is derived prod-only
    (`resolveClockifyAuditBase`) — see the AUDIT note below.
  - **Embedded session:** the session cookie is `SameSite=None; Secure; Partitioned`
    (required inside Clockify's cross-site iframe).
  - **Resilience:** the chat route guards async errors → a failed action returns an
    error receipt instead of crashing the process.

**Risky-write confirm flow PROVEN live (2026-06-08):** `scripts/live-confirm-flow.ts`
drove the never-before-browser-verified button-confirm safety mechanism over HTTP
against the real server + DeepSeek + dev host (`PASS=16 FAIL=0`): a risky prompt
returns a dry-run preview and executes nothing; typed "yes" never executes; a wrong
nonce is rejected; a nonce is bound to its own preview (cross-batch confirm rejected
— this is what scopes `Confirm all`); the correct button nonce executes exactly once
and the tag is really gone; the one-use nonce cannot be replayed; **policy is
re-checked at confirm time** (lowering a group after preview → `policy_denied`).
Expiry (5-min TTL) stays covered by `tests/unit/confirmations.test.ts` +
`tests/integration/risky-preview.test.ts`.

- `npm run verify` is green (**624 tests**: type-check + Vitest + build).
- **NDJSON streaming of the harness's progress (Phase 7 slice, 2026-06-09).**
  `POST /api/chat/stream` streams the HARNESS's progress — `{type:"result",result}`
  per harness result as it executes, then `{type:"reply",kind,text}` (the *truthful*
  reply), then `{type:"done"}` (`{type:"error"}` on model failure) — **never the
  model's tokens** (which would conflict with the truthful-preview override). The
  shared `executeChatTurn(claims, installation, message, onResult?)` is the single
  copy of the turn's safety logic; the JSON `POST /api/chat/messages` route is now a
  thin wrapper over it (behavior identical). UI: `createNdjsonParser` (stateful line
  parser, tested) + `submitStreaming` (receipts render as they arrive; previews are
  **batched** and flushed at the reply so "Confirm all" stays one card; tested) +
  `createFetchApi.streamMessage`; the composer streams (`submitMessage` is the
  non-stream fallback). The dominant model-call latency is unchanged, but multi-action
  turns disclose progressively.
- **UI accessibility + responsive status (Phase 7 slice, 2026-06-09).** The embedded
  chat got a WAI-ARIA pass: an `<h1>` header; the message log is `role="log"
  aria-live="polite"` (new turns are announced); errors are `role="alert"`, the
  working status `role="status"`; the composer input and every permission `<select>`
  have accessible names; receipt/preview cards are labelled groups (Details toggle has
  `aria-expanded`, Undo is labelled); CSS adds a visible `:focus-visible` ring and
  honors `prefers-reduced-motion`. Responsiveness: the send flow is the testable
  `submitMessage(api, msg, hooks)` orchestrator — it announces "Assistant is working…"
  BEFORE the request and always clears it (even on error), disables Send + sets
  `aria-busy`, guards double-submit, and returns focus to the input. **Note on
  streaming:** token-streaming the *model's narration* conflicts with the
  truthful-preview safety override (a streamed "Done!" could leak before the route
  replaces it for a pending risky preview), so we stream a *status* + the *truthful*
  result, not model tokens. (The safety-compatible NDJSON streaming of per-result
  receipts is now built — see the streaming bullet above.)
- **Operational metrics (Phase 7 slice, 2026-06-09).** "Is the assistant working?"
  derived from data already recorded (every action is audited with its receipt;
  every risky preview is a pending-confirmation row with a status). `GET /api/metrics`
  (session-gated, scoped to the caller's OWN actions for privacy; optional `?since=<ISO>`)
  returns per-action success/failure (busiest first), an **error taxonomy** (counts by
  code), and **confirm/cancel/expire/pending** rates. Pure aggregation in
  `src/metrics/metrics.ts` (`buildMetrics`), fed by `store.listActionOutcomes` +
  `listConfirmationOutcomes`. `scripts/eval-trend.ts` summarizes the timestamped
  `eval-results/*.json` into a pass-rate/consistency trend over time. (Remaining
  Phase 7 — stable hosting, prod security review, token rotation, prod AUDIT-host
  clearance — needs live credentials / infra decisions and is human-gated.)
- **Curated intent actions (Phase 6, 2026-06-09).** High-level "jobs to be done"
  (`src/harness/workflows/curated.ts`) so the model reaches for one clear verb
  instead of scrambling ~115 primitives, with the harness owning what the model is
  bad at. `clockify_period_report` (read) resolves a **period keyword**
  (today/yesterday/this_week/last_week/this_month/last_month/last_7_days/last_30_days/
  this_quarter/last_quarter/this_year/last_year) → a UTC date range server-side via
  `ctx.now`, then runs the summary/detailed/weekly report (the model never computes
  calendar dates). `clockify_onboard_user` (risky) bundles invite + group-adds into
  **one preview**, committed atomically via the composition layer (invite required,
  group adds best-effort). Primitives remain for power use. **Measured (deepseek-v4-pro,
  tool mode, repeat=3): curated cases 12/12 adopted** — the model picks the curated
  job over primitives; the `defaults` report cases were widened to accept
  `period_report` (equally valid — calibration, not a regression). Further curated
  jobs (invoice_client, set_up_project, audit_changes, and a permissions job to close
  the `permissions/full` action-selection gap) follow the same pattern.
- **Grounding & early constraint surfacing (Phase 4, 2026-06-09).** Read the world
  before acting; never punt vaguely; warn about platform limits in the **preview**,
  before confirm. (1) `clockify_invoices_create` now adds the invoice-item-type caveat
  to the **preview card** whenever the invoice has line items (a $0 outcome is no
  longer a confirm-time surprise — there's no API to list/create item types, so it's a
  surfaced known constraint). (2) Name-not-found clarifies are **specific** — they
  offer "did you mean one of these?" options built from the candidates already fetched
  during resolution (`resolve.suggestOptions`: prefers names containing the query,
  falls back to all active, excludes archived, capped at 12), never "go list them
  yourself." Applied to invoices_create's client, projects_delete, tags_delete, and
  create_work_package's project `clientName`. No extra Clockify calls.
- **Undo the last reversible action (Phase 5b, 2026-06-09).** A successful action
  that CREATED entities now carries a one-use `undo: { id }` handle (chat safe-write
  + confirm commit paths); `POST /api/undo/:id` reverses it by deleting the created
  entities (`src/harness/undo.ts` → `reverseCreation`, read from
  `receipt.changed.created`, in REVERSE order: task→project→client). It re-checks
  write policy BEFORE consuming the one-use record (a lowered policy denies without
  burning it), then atomically claims (`markUndone`) and reverses; partial failure is
  a warning. Deletes/field-updates are out of scope (can't un-delete; restoring a
  field needs before-state we don't capture), and users/groups are deliberately NOT
  reversible. Store: `undo_records` table. UI: an **Undo** button on reversible
  receipts (flips to "Undone").
- **Idempotent confirmed commits (Phase 5a, 2026-06-09).** Re-confirming the SAME
  intent (issuing "invoice qwen for 1000" three times, or confirming a re-issued
  preview) no longer creates duplicates (the empty-`qwen`-invoice problem).
  `commitConfirmedOperation` (the single choke point for every risky commit, single
  + batch) looks up a workspace/admin/action-scoped **intent hash** after the policy
  gate and returns the prior receipt (annotated `idempotent_replay`) instead of
  mutating. Opt-in per action: `ActionDefinition.idempotencyKey(operation)` returns
  the SEMANTIC identity; `clockify_invoices_create` uses client + items + currency +
  notes, **excluding** the auto-generated number/issuedDate/dueDate (so two previews
  of the same request still dedupe). Ledger is store-backed (`idempotency_keys` table,
  10-min window via `src/harness/idempotency.ts` + `src/routes/api.ts`); only
  SUCCESSFUL commits are recorded (a failed attempt stays retryable); ledger-gated so
  every existing commit path is byte-identical without a ledger. (Undo of the last
  action is **Phase 5b**, done — see above.)
- **Atomic multi-step composition (Phase 3, 2026-06-09).** `src/harness/compose.ts`
  → `runComposition(steps)` is the **intent layer**: an ordered list of steps with
  transactional semantics in one place (so handlers + future curated actions don't
  each re-implement them). A **required** step that errors rolls back every entity
  created so far (undos run in REVERSE via `deleteEntity`) → **no orphans**; a
  **best-effort** step (`required:false`) that errors warns and continues; a step may
  **stop** with a clarify/preview (not a failure — prior creates are kept, matching
  the old behavior). Only CREATED entities get an undo; reused entities are never
  rolled back. `clockify_create_work_package` is re-expressed on it (client/project/
  task = required, timer = best-effort) — behavior parity held by the existing 8
  safe-write tests; 4 new tests pin rollback/reuse/best-effort-timer. **Not touched:**
  the risky `invoices_create + items` commit path (an item-add failure shouldn't roll
  back a valid invoice — that's idempotency/undo, Phase 5); the core is ready to
  compose it later.
- **Native tool-calling is now the default planner mode (Phase 2, 2026-06-09).**
  The model calls **typed tools** whose arguments the provider validates against a
  JSON schema generated from the SAME Zod schema the harness validates with
  (`src/harness/tools.ts` → `toolsForModel()`, via the new `zod-to-json-schema`
  dep). Free-form JSON is now the **fallback** (`LLM_MODE=json`, and automatically
  for the `gemini-cli` backend, which has no `completeWithTools`). `planConversation`
  branches on `useTools` + client support; **defense in depth is unchanged** — every
  tool-call argument still passes through the action's Zod schema + the risk/policy
  gate before executing (provider validation is convenience, never the trust
  boundary), and risky writes still preview → button-confirm. The tool system prompt
  (`buildToolSystemPrompt`) drops the JSON-shape instruction + the redundant catalog
  listing (the tools carry the schemas) but **keeps the action-selection nudges**
  (delete-by-name-don't-list, create+`startTimer`, act-don't-just-describe) and all
  safety invariants — trimming those first regressed name-resolution, and the meter
  caught it. **Measured (deepseek-v4-pro, repeat=3): tool-calling 95.2% pass / 92.9%
  consistency vs JSON 88.9% / 91.3% (+6.3pp pass, +5 stable-pass).** The arg-shape
  class is **eliminated** (name-resolution + billing args now solid); remaining misses
  are action *selection* (`permissions/full` intent recognition → Phase 6) or noise.
  A/B with `scripts/eval-planner.ts --json-mode`.
- **Planner eval harness + arg contract in the prompt (Phase 1, 2026-06-09).**
  Quality is now a number. `scripts/eval-planner.ts` drives the **real planner**
  (planning only, no Clockify writes) over a tagged corpus (`scripts/eval/cases.ts`,
  ~42 cases) and scores each plan with a pure scorer (`src/eval/score.ts`),
  reporting **pass-rate AND a consistency metric** (`--repeat=N` → % of runs that
  produce the identical action+arg-keys — outcome determinism, not token-level).
  `--no-args` runs an A/B baseline with the arg contract off; results write to
  `eval-results/<ts>.json` (gitignored). Run:
  `npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3`.
  **1B — the argument contract is now in the system prompt:** each action renders
  as `- <name> (group; risk) args{<sig>}: <desc>` where `<sig>` is a terse Zod-
  derived signature (`src/harness/arg-summary.ts`, e.g. `clientName?: string;
  items?: object[]`), plus a rule to use those exact arg names. **Measured on
  deepseek-v4-pro (repeat=3): baseline (arg contract OFF) 85.7% pass / 86.5%
  consistency → with the contract 90.5% pass / 90.5% consistency (+4.8pp /
  +4.0pp).** Biggest wins are exactly the arg-shape/action-disambiguation class
  (reports_weekly/detailed stop collapsing to review_week/clarify;
  update_permissions consistently uses the `groups` key; compose uses canonical
  `project`). Prompt grows ~+1.9k tokens (cacheable). The durable version is
  Phase 2 (native tool-calling); the meter now judges it. The model is still sent
  only the catalog + policy — no tokens/secrets/headers; signatures read the
  schema, not values.
- **Truthful previews (safety, 2026-06-08):** the model sometimes narrated "Done!/
  Confirmed" in its reply for a risky action the harness actually returned as a *pending
  preview* — so the chat bubble claimed success above an un-clicked Confirm button, and
  that false claim was stored in history (convincing the model on later turns the action
  had happened). The chat route now **deterministically replaces** the reply text with a
  truthful "review and click Confirm — nothing has been changed yet" whenever previews
  are pending, and stores THAT (not the model's claim). Only the button confirm executes.
  The UI also renders receipt **warnings inline** and shows "Done — with notes" for a
  partial success (e.g. invoice created but the line item couldn't be added), so a
  partial result is never shown as a clean success.
- **Invoice creation smoothed (2026-06-08):** `clockify_invoices_create` used to punt
  for a client id (it only displayed `clientName`) and required number/dates/currency,
  and there was no way to add a line item to the not-yet-created invoice. Now it
  **resolves the client by name** (clarify on none/ambiguous), **defaults**
  number/issuedDate(+today)/dueDate(+30d)/currency(USD) — shown in the preview — and
  accepts inline **`items`** (description/quantity/amount) added onto the new invoice in
  the same preview→confirm step. **Invoice item types are workspace-configured named
  entities** (Clockify → Workspace settings → Invoices); a fresh workspace has NONE
  (`MANUAL`/`NEW DEFAULT`/etc. all 404 `"Invoice item type with name X not found"`, and
  there's no API to list/create them), so a failed item add no longer dumps a raw 404 —
  the invoice is still created and the receipt carries an **actionable warning**.
  `itemType` defaults to `"NEW DEFAULT"` and is overridable. Proven live
  (`scripts/live-invoice-flow.ts`).
- **Planner backend is selectable (`LLM_PROVIDER`).** Default `http` = the
  OpenAI-compatible client (`createModelClient`; DeepSeek via `LLM_BASE_URL`/
  `LLM_API_KEY`/`LLM_MODEL`). Set `LLM_PROVIDER=gemini-cli` to instead drive the
  planner through the **authenticated `gemini` CLI** (`src/assistant/gemini-cli-client.ts`,
  no API key — it runs `gemini -o json -p <prompt>` and reads the envelope's
  `.response`; optional `GEMINI_MODEL` pins a model, else the CLI router picks).
  The gemini provider needs no `LLM_BASE_URL`/`LLM_API_KEY`. It is **dev-only**:
  each chat turn spawns the CLI, so it is slower than the HTTP path. Proven live —
  the embedded chat (reads, safe write, risky write→preview→confirm) ran end-to-end
  on Gemini (`scripts/live-planner-quirks.ts`, PASS=9). Switch back with
  `LLM_PROVIDER=http` (or remove the line).
- The REST `WorkspaceClient` adapter is composed from a multi-host core
  (`src/clockify/rest/core.ts`: api / reports / audit hosts) plus one typed REST
  module per area (`src/clockify/rest/<area>.ts`), assembled in
  `src/clockify/rest-workspace.ts`. Each area also has a port slice
  (`src/clockify/ports/<area>.ts`) and a workflow module
  (`src/harness/workflows/<area>.ts`). The generic `manage_*`/`prepare_*` actions
  were superseded by typed per-area actions (invoices, expenses, time-off,
  schedule, webhooks).
- The exhaustive live exerciser drives every action through the **real harness**
  (preview→confirm→commit) against a sacrificial workspace:
  `scripts/live-full.ts` → `PASS=115 PREVIEW_OK=28 FAIL=0 SKIP=4`, and
  `scripts/live-sweep.ts` → 0 leftovers. Risky writes that need live preconditions
  or have high blast radius (time-off/approvals/scheduling-publish/user role &
  invite & deactivate) are **preview-only** in the live run by design; their
  request shapes are pinned by mocked-fetch unit tests.
- Live API facts worth knowing (encoded in code + tests): list endpoints often
  return envelopes (`{webhooks:[…]}`, `{expenses:{expenses:[…]}}`, `{invoices:[…]}`,
  `{total,requests:[…]}`) not arrays; several single-GETs 405 so the item is read
  from the list (invoice items, custom fields, holidays, scheduling assignments,
  approvals, groups); the time-entry/expense/holiday/scheduling PUTs replace and
  need the full body; amounts are minor units on the wire for invoices/payments
  but **major** for expenses; the webhook `authToken` secret is never accepted nor
  returned; reports run on the reports host (`POST /reports/{summary|detailed|
  weekly}`); audit search runs on the audit host (`POST /audit-log`).
- **Reports host (Phase 14): cleared on the X-Addon-Token.** The reports host
  (`reports.api.clockify.me/v1`) authenticates with the production add-on token —
  the multi-host core sends it over the same host-routing + auth-header path as the
  api host (the dev API key works too). No remaining gate for reports.
- **AUDIT host (Phase 15) — resolved for non-prod; prod clearance still unconfirmed.**
  Clockify publishes **no audit URL claim** (confirmed by the docs *and* by decoding
  the live install + user tokens: the only URL claims are
  backendUrl/reportsUrl/locationsUrl/screenshotsUrl/ptoUrl). The audit log lives only
  on the `auditlog-api.api.<tenant>` subdomain of `api.<tenant>` (prod/regional)
  hosts, so it is derived prod-only by `resolveClockifyAuditBase`; on the dev/path
  host (`developer.clockify.me/api`) there is no audit host, and the core now returns
  a clean **"Audit log is not available in this Clockify environment"** error receipt
  instead of the old raw `fetch failed` (verified live — server stays up). What
  remains unconfirmed is the production X-Addon-Token **clearance** for the audit host
  when it *does* exist: `POST /audit-log` + the experimental entity-changes feed 400'd
  on the earlier spike (shapes pinned by unit tests). Re-run `scripts/host-auth-spike.ts`
  with a captured prod `LIVE_ADDON_TOKEN` to settle that. The add-on-token install
  path (`scripts/addon-smoke.ts`) is also human-gated.
- **Deferred:** Phase 17 (raw `clockify_api_get`/`api_request` fallback) — omitted
  from V1 (letting the model propose arbitrary paths conflicts with "the harness
  decides, not the model"); requires a safety review before ever building.
- **Live planner quirks RESOLVED + PROVEN live (2026-06-08):** the two known
  DeepSeek-planner gaps are now smoothed end-to-end (`scripts/live-planner-quirks.ts`,
  `PASS=9 FAIL=0`, self-cleaning + 0 leftovers):
  (1) **"create a project AND start a timer on it" in ONE turn** no longer starts a
  BARE timer. `clockify_create_work_package` gained an optional `startTimer` that
  resolves/creates the project (and task) and starts the timer on that id
  server-side (gated additionally by `time_tracking` write; skipped with a warning
  when read-only). Crucially, live debug showed the planner emits `startTimer: true`
  (boolean) and a flat `projectName` (not nested `project:{name}`), so the schema now
  accepts a boolean OR options object and a `z.preprocess` folds bare-string entities
  + flat `*Name` aliases into the canonical nested shape.
  (2) **`clockify_tags_delete` dropping its `id`** no longer dead-ends at
  `invalid_args`: the handler accepts an exact `name` and resolves it to an id
  (list→`matchByName`, clarify on none/many), with the resolved id pinned into the
  confirmable operation. The planner prompt was reworded to pass the name directly
  (not list-first) and to use `create_work_package`+`startTimer` for one-turn
  create+timer. Note: Clockify **reserves a project name even after archive-then-delete**
  (so tests use unique `AIASSIST_SMOKE_*` names).
- **Broad live "dogfood" tour smoothed more arg-shape edges (`scripts/live-chat-tour.ts`,
  37 turns / 25–28 actions per run):** the same "planner can't see the schema, so it
  omits/flattens required args" class showed up in more places, all now fixed (defaults
  + input normalization only — no host/auth changes): **reports** default the date range
  to the last 7 days (weekly especially used to `invalid_args`); **audit search** defaults
  actions + range (so on dev it returns the clean "not available" message, not
  `invalid_args`); **`clockify_projects_delete`** resolves by name like tags;
  **`assistant_update_permissions`** accepts the flat `{invoices:"read"}` / `{group,level}`
  shape. Verified live: delete-project-by-name and set-permission now preview→confirm
  end-to-end. **Still open (not regressions):** `webhooks_list` + `workspace_get`
  (`GET /workspaces`) return **401 "API is not accessible"** with the add-on token on the
  **dev host** (likely a dev-environment access limit; may differ in prod — left as-is to
  avoid changing prod behavior); `clockify_log_work` can `invalid_args` when the planner
  omits the required `start`; and a tag *rename* sometimes makes the planner call
  `clockify_tags_list` instead of `clockify_tags_update` (narrates "renaming" but doesn't).

## Known limitations & honest state (2026-06-09, post-roadmap)

Most of the architectural limits that motivated Phases 1–7 are now **resolved**: the
arg-shape-guessing class is eliminated by native tool-calling (Phase 2); multi-step
intents are atomic (Phase 3); duplicate invoices are impossible (Phase 5a); the last
action is undoable (Phase 5b); platform constraints surface in the preview (Phase 4); and
the model reaches for curated jobs (Phase 6). What remains below is either a **Clockify
platform constraint** or a **human-gated launch item** (hosting, prod security/clearance)
— **none is fixed by swapping the LLM**:

- **(Phase 1B done) The planner is now sent a terse arg signature per action**, not just
  name/description/risk — so it stops guessing argument shapes (flat `projectName`,
  `startTimer:true`, missing ids, omitted required fields) as often. We still keep the
  per-action mitigations as defense in depth: forgiving Zod (`z.preprocess`/unions),
  server-side defaults (reports/audit ranges, invoice number/dates/currency), and
  name→id resolution (tags/projects/clients). **(Phase 2 done, 2026-06-09)** native
  tool/function-calling is now the **default** (`LLM_MODE=tool`): the provider validates
  args against JSON schemas generated from the Zod schemas, so the arg-shape class is
  **eliminated** (tool-calling 95.2% pass vs JSON 88.9% on deepseek-v4-pro). The Zod +
  risk/policy gate still re-validates every call. What remains is **action selection**
  (e.g. `permissions/full` intent recognition) — that's a curated-intent-action job
  (Phase 6), not an arg-shape problem.
- **Invoice line items require a workspace-configured invoice item type** (Clockify →
  Workspace settings → Invoices). There is **no API to list or create them**; a fresh
  workspace has none, so amounts stay $0 until an admin sets one up in the UI (one-time).
  The add-on now warns about this **in the preview** (Phase 4) so the $0 outcome is
  surfaced before confirm, and still returns an actionable warning on the receipt
  instead of a silent $0. Not a model or code bug — a Clockify platform constraint.
- **Models narrate false completion.** Every backend tried (deepseek-v4-pro, gemini-cli)
  sometimes says "Done/Confirmed" for a pending risky preview. The route now overrides
  this deterministically (truthful previews) — the right fix, model-agnostic.
- **Smaller open edges:** ~~`clockify_log_work` can `invalid_args` when the planner omits
  the required `start`~~ **FIXED (2026-06-09):** `log_work` now takes a duration
  (`durationHours`/`durationMinutes`) + a **relative** day (`date: today/yesterday`/`dayOffset`)
  and the harness anchors start/end server-side (`ctx.now` does the date math — the model
  doesn't know the calendar date); fired ~33%→75% (repeat=8). `assistant_update_permissions`
  now advertises its levels + phrasings so "give me full access to reports" maps to it
  (0%→37.5%; a fuller fix is the curated-action layer, Phase 6). Still open: tag *rename*
  sometimes lists instead of updating; `webhooks_list`/`workspace_get` 401 on the dev host
  (likely dev-only).
- **Model choice:** not the bottleneck. `deepseek-v4-pro` (current) and the `gemini-cli`
  backend behave similarly on the above; a swap won't change the schema-guessing or the
  invoice-item-type limits. Switch backends via `LLM_PROVIDER` (see above) only for
  cost/latency/quality preference, not to fix these.
- **Human-gated launch items (the only "open work", all outside the codebase):**
  (1) **stable hosting** — the dev quick-tunnel URL rotates; a named-tunnel-on-a-domain
  (Cloudflare zone) or a real deploy is an infra decision; (2) **prod security review +
  token rotation**; (3) **prod AUDIT-host `X-Addon-Token` clearance** — run
  `scripts/host-auth-spike.ts` with a captured prod `LIVE_ADDON_TOKEN` to settle it (dev
  cleanly reports "audit log not available", so it's prod-only). These need the user's
  decisions/credentials, not more code.

## Build, Test, Run

```bash
npm install            # first time
npm run type-check     # tsc --noEmit
npm test               # vitest run (fakes only; no network)
npm run build          # tsc + vite -> dist/server, dist/ui
npm run verify         # type-check + test + build (the gate)
npm run dev            # tsx src/server.ts (needs env, see below)
```

## Local dev hosting (tunnel)

The embedded add-on must be reachable over HTTPS for Clockify to load it. For dev
we use a **Cloudflare quick tunnel** to `:3001`. Its `*.trycloudflare.com` URL is
**random per `cloudflared` start** (no Cloudflare account/domain needed, but the URL
is not fixed). Manage the tunnel + server as one unit with `scripts/dev-tunnel.sh`:

```bash
scripts/dev-tunnel.sh up       # start tunnel+server, write BASE_URL into .env.server, print URL
scripts/dev-tunnel.sh status   # tunnel URL, BASE_URL match, server health
scripts/dev-tunnel.sh sync     # tunnel up but BASE_URL stale -> rewrite + restart server
scripts/dev-tunnel.sh restart  # rotate the tunnel (NEW url) + resync
scripts/dev-tunnel.sh down     # stop both
```

`up` is **idempotent**: a healthy managed tunnel is reused (URL does NOT rotate), so
the URL stays fixed for the life of that `cloudflared` process. When the URL *does*
change (first start, or after `restart`/a crash), the script rewrites `BASE_URL` and
restarts the server automatically — but you must still **re-register the manifest URL
in the dev console** (Clockify pins the component `baseUrl` at install time): open
developer.clockify.me → workspace settings → Add-ons, paste `<url>/manifest` into
"Insert link", and (uninstall then) INSTALL. A truly fixed URL needs the
named-tunnel-on-a-domain route instead (Cloudflare zone + `cloudflared tunnel
login`/`create`/`route dns`).

## Runtime & Known Constraints

- **Node:** use Node 20+. On this machine only **Node 26** runs (the brew
  `node@22` binary is broken), so `better-sqlite3` is pinned to **^12** (v11 has
  no Node-26 prebuild). Do not downgrade it unless the runtime changes.
- **Clockify seam:** all Clockify I/O goes through the `WorkspaceClient` port
  (`src/clockify/client.ts`). Production uses the REST adapter
  (`src/clockify/rest-workspace.ts`) with `X-Addon-Token` auth, wired in
  `server.ts` (`liveClockifyForWorkspace`). Tests use
  `tests/helpers/fake-clockify.ts`. The legacy `clockify-sdk-ts-115` wrapper is
  unbuilt and **not on the request path**. The adapter does **I/O only** — all
  risk/policy/confirmation logic stays in `src/harness/*`.
- **Auth model:** the add-on authenticates with the installation **add-on token**
  (`X-Addon-Token`), never an API key. `createWorkspaceClockifyClient` must never
  pass `apiKey` (enforced by test).
- **Token verification key (install fix):** inbound Clockify add-on JWTs (the
  component `auth_token` and the `x-addon-lifecycle-token`) are RS256-signed by
  Clockify with **one platform-wide public key**, published at
  `{apiUrl}/api/auth/public-key` — it is **not** a per-add-on/dev-console key. It
  is embedded as the built-in default in `src/addon/clockify-public-key.ts`
  (SPKI sha256 `0cebc449…`, pinned by `tests/unit/clockify-public-key.test.ts`),
  so install/lifecycle verification works out of the box. `CLOCKIFY_ADDON_PUBLIC_KEY_PEM`
  is now **optional** and only overrides the key for non-prod Clockify
  environments/regions. `/lifecycle/installed` requires only `authToken` +
  `workspaceId` (addonId falls back to the token claims; `addonUserId` optional),
  matching the real INSTALLED payload — covered by `tests/integration/lifecycle.test.ts`.

## Live Testing (opt-in, sacrificial workspace only)

Live tests are disabled by default and target a throwaway workspace. They read a
gitignored `.env`. Never commit or paste these values.

```bash
# Exhaustive harness exerciser (API-key adapter): every action through
# preview→confirm→commit, self-cleaning AIASSIST_SMOKE_* resources.
LIVE_CLOCKIFY=1 LIVE_CLOCKIFY_API_KEY=... LIVE_WORKSPACE_ID=... \
  npx tsx scripts/live-full.ts

# Safety-net sweep: removes any leftover AIASSIST_SMOKE_* (must report 0).
LIVE_CLOCKIFY=1 npx tsx scripts/live-sweep.ts

# Smaller no-install dev smoke (read + safe write + one risky round-trip).
LIVE_CLOCKIFY=1 npx tsx scripts/live-smoke.ts

# Live model round-trip (planner only; sends the model only catalog + policy).
npx tsx scripts/chat-smoke.ts            # needs LLM_BASE_URL / LLM_API_KEY / LLM_MODEL

# Planner eval (the meter): score the real planner over scripts/eval/cases.ts.
# Planning only — NO Clockify writes. Reports pass-rate + consistency; writes
# eval-results/<ts>.json (gitignored). --no-args is the arg-contract-OFF A/B baseline.
npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3
npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3 --no-args   # baseline

# Production add-on-token path (needs a captured installation token).
LIVE_CLOCKIFY=1 npx tsx scripts/addon-smoke.ts   # needs LIVE_ADDON_TOKEN / LIVE_BACKEND_URL

# Risky-write confirm flow, proven over HTTP against the running add-on (needs an
# active install in the store + a live tunnel/server + DeepSeek). It mints a user
# token via the installation->user token exchange (OWNER_USER_ID = the workspace
# owner's member id, NOT the install token's `user` claim), or pass USER_TOKEN /
# USER_TOKEN_FILE from the live iframe. PASS=16 against the dev sandbox.
npx tsx --env-file=.env.server scripts/live-confirm-flow.ts

# Agentic loop, proven against the REAL model + REAL Clockify host (the GOAL
# acceptance test, minus the browser-iframe click): runs runAgentTurn with the
# real DeepSeek backend + real REST adapter, simulating the button-confirm through
# the real commitConfirmedOperation + durable resume. Self-cleaning. PASS=10.
LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-agentic-flow.ts

# Agentic task-completion eval (the meter for the loop): real model + real harness
# vs the fake workspace, scoring TERMINAL outcomes; --single-turn is the pre-loop
# baseline. deepseek-v4-pro repeat=3: agentic 90.5% vs single-turn 57.1%.
npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3
npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3 --single-turn

# Planner-quirks proof: one-turn create-project+start-timer attaches the timer, and
# delete-tag-by-name returns a preview->confirm. Same bootstrap as confirm-flow;
# self-cleaning AIASSIST_SMOKE_* with a final 0-leftover sweep. PASS=9.
npx tsx --env-file=.env.server scripts/live-planner-quirks.ts

# Broad multi-feature "dogfood" tour: ~37 turns across every area in one flowing
# conversation; prints a per-turn trace + a rough-edge summary. Read-heavy,
# self-cleaning (only confirms its own AIASSIST_SMOKE_* previews + permission
# toggles, restored at the end). Use it to find planner/harness rough edges.
npx tsx --env-file=.env.server scripts/live-chat-tour.ts
```

The add-on's own request path uses the REST `WorkspaceClient` adapter with the
installation add-on token (`X-Addon-Token`). The API-key scripts are dev-only and
NOT the production auth model.
