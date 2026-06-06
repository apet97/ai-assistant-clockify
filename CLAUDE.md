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

V1 is implemented and verified, and **all existing catalog actions are now wired
to live Clockify**.

- `npm run verify` is green (**156 tests**: type-check + Vitest + build).
- The REST `WorkspaceClient` adapter (`src/clockify/rest-workspace.ts`) implements
  the full port over the Clockify REST API and is wired into `server.ts` with
  `X-Addon-Token` auth. There are **no remaining `// TODO verify` shims** — the
  previously-stubbed paths (webhooks, expenses, time-entry update, invoices,
  entity update, time-off, schedule) are implemented against the real API shapes.
- The exhaustive live exerciser drives every action through the **real harness**
  (preview→confirm→commit) against a sacrificial workspace:
  `scripts/live-full.ts` → `PASS=28 PREVIEW_OK=2 FAIL=0`, and
  `scripts/live-sweep.ts` → 0 leftovers. `manage_time_off` and `manage_schedule`
  are **preview-only** in the live run by design (no GET-able pending request;
  publishing has real assignee side effects); their request shapes are pinned by
  mocked-fetch unit tests.
- Live API facts worth knowing (encoded in code + tests): `GET /webhooks` and
  `GET /expenses` return envelopes (`{webhooks:[…]}`, `{expenses:{expenses:[…]}}`),
  not arrays; the time-entry `PUT` replaces and requires `start` (GET-then-PUT);
  invoice `issuedDate`/`dueDate` and expense `date` need full ISO datetimes (not
  `YYYY-MM-DD`); expense create is `multipart/form-data` and requires `userId`;
  webhook create requires `webhookEvent` + an HTTPS url + a trigger source.
- **Next big effort (not started):** full Clockify REST surface parity with the
  Go reference `addons-me/goclmcp` (~156 ops) — see `slopbranch:API_COVERAGE_PLAN.md`.
- **Gated/pending:** the production add-on-token path (`scripts/addon-smoke.ts`)
  needs a captured installation token from the Clockify developer console
  (Phase 5, human-gated).

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
