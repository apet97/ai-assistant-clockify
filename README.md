# AI Assistant for Clockify

An **admin-only** AI assistant embedded inside Clockify. Workspace admins ask for
Clockify work in plain language; the model proposes actions, and a deterministic
**action harness** validates every proposal against per-admin permissions and a
risk policy before anything touches Clockify.

The model never executes anything itself and never sees a secret. It can only
*suggest* named actions from a fixed catalog — the backend decides what (if
anything) runs.

## Highlights

- **Admin/owner only.** Non-admins are rejected before a session is ever created.
- **Per-admin, per-workspace permissions.** Default is full `read_write` for every
  feature group; each admin manages only their own policy, from inside the chat.
- **Safe writes execute immediately** and return a structured receipt.
- **Risky writes require a dry-run preview + a button confirmation.** Typed text
  such as "yes" never executes a risky action. `Confirm all` applies only to the
  exact previewed batch.
- **One-use, time-limited confirmations** (5 min) bound to session + workspace +
  admin, a salted nonce hash, and an operation hash. Policy is re-checked at
  confirm time.
- **The model receives no secrets** — never Clockify tokens, add-on tokens,
  session secrets, the model API key, or raw headers. Tokens are encrypted at
  rest (AES-256-GCM). Clockify-sourced text is treated as untrusted data, not
  instructions.

## How it works

```
Clockify (admin component)
        │  add-on token (X-Addon-Token)
        ▼
Express backend ── session (signed cookie) ── SQLite (policy, installs, confirmations)
        │
        ├─ assistant/   model client + prompt builder + validated planner (JSON, 1 repair retry)
        │
        └─ harness/     the safety boundary:
                        catalog · permissions · risk · receipts · confirmations
                        └─ executes validated actions via the Clockify WorkspaceClient port
```

The model only ever sees the action catalog and the current policy. A proposed
plan is schema-validated, permission-checked, and risk-classified. Safe actions
run and return a receipt; risky actions return a preview that the UI confirms
with a button.

## Tech stack

TypeScript · Express · vanilla Vite UI · SQLite (`better-sqlite3`) · Zod ·
Vitest · Supertest. No React/Next/Prisma/Redis/queues — kept deliberately small.

## Project structure

```
src/
  config.ts            env config (Zod-validated)
  db/                  SQLite schema, store, token encryption
  auth/                admin role check, signed session cookie
  addon/               manifest + Clockify token verification
  clockify/            WorkspaceClient port + REST adapter (X-Addon-Token)
  assistant/           model client, prompt builder, validated planner
  harness/             action contracts, executor, catalog, permissions,
                       risk, receipts, confirmations, workflows/*
  routes/              lifecycle, component, api, shared deps
  server.ts            createApp(deps) + start()
  ui/                  vanilla TS chat UI
tests/                 unit + integration (fakes only, no network)
scripts/               opt-in live smokes (sacrificial workspace)
```

## Getting started

Requires Node 20+.

```bash
npm install
cp .env.example .env     # then fill in real values
```

### Verify, build, run

```bash
npm run type-check       # tsc --noEmit
npm test                 # vitest run (fakes only; no network)
npm run build            # -> dist/server, dist/ui
npm run verify           # type-check + test + build (the gate)
npm run dev              # tsx src/server.ts (needs .env)
```

`GET /manifest` serves the admin-only Clockify add-on manifest — a **sidebar**
component (`/component/assistant`) plus an add-on icon at `/icon.svg`. It installs
and runs end-to-end on real Clockify workspaces (verified on a dev workspace:
install → sidebar → chat → action → receipt).

### Environment

See [`.env.example`](./.env.example) for the full list. Key variables: `PORT`,
`BASE_URL`, `CLOCKIFY_ADDON_KEY`, `SESSION_SECRET`, `DATA_ENCRYPTION_KEY`
(32-byte key for token encryption), `DATABASE_PATH`, and `LLM_BASE_URL` /
`LLM_API_KEY` / `LLM_MODEL` for the OpenAI-compatible model endpoint.
`CLOCKIFY_ADDON_PUBLIC_KEY_PEM` is **optional** — Clockify's fixed platform
token-signing key is built in; only set it to target a non-production Clockify
environment. The Clockify API/reports hosts are read from the install token (never
hardcoded), so the add-on works across dev/regional environments unchanged.

## Live testing (opt-in)

Tests run entirely against fakes by default — no network, no credentials. Live
checks are opt-in and **must target a throwaway workspace**. They are gated by
env (`LIVE_CLOCKIFY=1`, plus the relevant tokens/IDs):

- `scripts/live-smoke.ts` — drives the real harness (read + safe write + risky
  preview→confirm→commit) via a personal-API-key adapter; self-cleaning.
- `scripts/addon-smoke.ts` — exercises the production add-on-token request path.
- `scripts/chat-smoke.ts` — live model round-trip (the model is sent only the
  action catalog + policy, never a token).

Never commit or paste live credentials.

## Security

The model is treated as untrusted: it proposes, the harness disposes. Secrets
never reach the model or the logs, installation tokens are encrypted at rest,
and risky writes can only execute through an explicit button confirmation. See
the inline documentation in `src/harness/` for the enforcement details.
