# CLAUDE.md — AI Assistant Add-on

Read this first in every Claude Code session.

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
  live scripts under `scripts/`, `README.md`, and this file + `AGENTS.md`.
- **`slopbranch`:** the full design-doc set and project skills/agents
  (`PRD.md`, `SPEC.md`, `TECH_STACK.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`,
  `SAFETY_AND_PERMISSIONS.md`, `IMPLEMENTATION_PLAN*.md`, `TESTING_AND_ACCEPTANCE.md`,
  `API_COVERAGE_PLAN.md`, `NEXT_SESSION_PROMPT.md`, `REFERENCES.md`, `.claude/`).
  Read those there (`git show slopbranch:SPEC.md`, etc.) when you need the
  contracts behind the code.

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

V1 is implemented and verified, and the **full Clockify REST surface parity
effort (`slopbranch:API_COVERAGE_PLAN.md`, Phases 0–16) is COMPLETE** — ~115
typed catalog actions across 16 feature areas and 3 API hosts, each routed
through the existing safe/risky harness.

- `npm run verify` is green (**416 tests**: type-check + Vitest + build).
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
- **Pending (not blocking):** the production X-Addon-Token clearance for the
  REPORTS + AUDIT hosts is unverified — no `LIVE_ADDON_TOKEN` in `.env`
  (Phase-5 dev-console gated). Reports work live via the API key; audit
  `POST /audit-log` + the experimental entity-changes feed 400 live (shapes pinned
  by unit tests). Re-run `scripts/host-auth-spike.ts` once a token is captured. The
  add-on-token install path (`scripts/addon-smoke.ts`) is also human-gated.
- **Deferred:** Phase 17 (raw `clockify_api_get`/`api_request` fallback) — omitted
  from V1 (letting the model propose arbitrary paths conflicts with "the harness
  decides, not the model"); requires a safety review before ever building.

## Build, Test, Run

```bash
npm install            # first time
npm run type-check     # tsc --noEmit
npm test               # vitest run (fakes only; no network)
npm run build          # tsc + vite -> dist/server, dist/ui
npm run verify         # type-check + test + build (the gate)
npm run dev            # tsx src/server.ts (needs env, see below)
```

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

# Production add-on-token path (needs a captured installation token).
LIVE_CLOCKIFY=1 npx tsx scripts/addon-smoke.ts   # needs LIVE_ADDON_TOKEN / LIVE_BACKEND_URL
```

The add-on's own request path uses the REST `WorkspaceClient` adapter with the
installation add-on token (`X-Addon-Token`). The API-key scripts are dev-only and
NOT the production auth model.
