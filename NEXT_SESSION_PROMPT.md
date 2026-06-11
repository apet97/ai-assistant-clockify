# Takeover / next-session kickoff — AI Assistant add-on

> **Read `CLAUDE.md` → "Handoff note" first** (it's the source of truth for where this
> stands). `NEXT_SESSION_PLAN.md` is the forward plan (Phases 1–7 — all done in-repo).
> **This file** is the live-environment kickoff: how to bring the tunnel + install back
> up and drive the chat. Runtime values (tunnel URL especially) are **ephemeral** —
> verify them first.

## Where this stands (2026-06-11)

Everything buildable is complete: V1 + full REST parity + the "trust lives in the
code" roadmap + the **durable agentic loop (default ON)** + the 322-prompt
live-loop fix arc, all re-verified by a live regression run in the embedded chat,
plus the 2026-06-11 full-angle live investigation (safety 16/16, agentic 10/10 +
21/21, live-full 115/115, planner 98.6%, chat-tour clean — no product defect).
`npm run verify` is green at **881 tests** (madge 0), all pushed to `main`.
Highlights live: native **tool-calling**, atomic **composition**, **idempotency**
+ **undo**, preview-time **constraint surfacing** (incl. add-on platform
restrictions), name→id resolution (incl. **archived**), server-side dates (incl.
forward ranges), audit-log **recaps** (`assistant_recent_outcomes`), the
typed-consent guard, **metrics**, a11y, NDJSON streaming. See `CLAUDE.md`;
journals in `docs/HISTORY.md`.

**There are no open implementation tasks.** What remains is human-gated (hosting, prod
security review, prod AUDIT-host clearance — see the bottom). So a fresh session is for
**live dogfooding / regression** or **net-new scope with the user**.

---

Copy the block below into a fresh Claude Code session to live-test the **embedded**
Clockify "AI Assistant" add-on.

Continue the Clockify "AI Assistant" add-on. Repo:
`/Users/15x/Downloads/WORKING/addons-me/ai-assistant-addon` (branch `main`, pushed).
Read `CLAUDE.md` (Handoff note + Current Status) + `AGENTS.md` first, and recall the
project memories (`clockify-addon-public-key-builtin`, `clockify-api-base-resolution`,
`clockify-dev-console-login-and-reinstall`, `streaming-conflicts-truthful-previews`).
`npm run verify` is green at **881 tests**. Keep the discipline: failing test first,
verify green, focused commits, no new deps without my OK, never print/commit tokens.

## Bring the live environment up (do this first)

1. **Server + tunnel** are managed by `scripts/dev-tunnel.sh`. Run
   `scripts/dev-tunnel.sh status`.
   - Healthy + `BASE matches yes` → you're good; note the printed tunnel URL.
   - Down or `BASE matches NO` → run `scripts/dev-tunnel.sh up` (starts/reuses the quick
     tunnel, writes `BASE_URL` into `.env.server`, restarts the server, prints the URL).
   - Planner backend is selectable via `.env.server` `LLM_PROVIDER` + `LLM_MODE`:
     `http` (DeepSeek, api.deepseek.com, via `LLM_*`) or `gemini-cli` (authenticated
     `gemini` CLI, no key); `LLM_MODE=tool` (default, native tool-calling) or `json`
     (the fallback path). Current default is `http` + `deepseek-v4-pro` + tool mode.
   - The quick-tunnel URL is **random per `cloudflared` start** — assume it has rotated;
     `up`/`status` prints the current one. `up` is idempotent (URL only changes on
     `restart`/crash).
2. **If the tunnel URL changed, re-register the manifest** (Clockify pins the component
   `baseUrl` at install). Restore the dev-console session via the **CAKE test-accounts
   tab** in Debug Chrome (`developer.marketplace.cake.com/test-accounts` → **"Log in as"
   John Owner**, Workspace Owner — no password). Then workspace settings → Add-ons → AI
   Assistant → **Uninstall** (the dropdown "Uninstall" only fires via a real DOM
   `.click()` via `agent-browser eval`; in the modal type `UNINSTALL`), then paste
   `<url>/manifest` into "Insert link" → **INSTALL**. Verify the DB install row's
   `updated_at` jumps to now and `status=active`.
3. **Workspace:** dev "Marketplace Workspace" `69bda6b317a0c5babe34b4ff`; owner member id
   `69bda6b317a0c5babe34b4fe`. Drive the browser with `agent-browser` on Debug Chrome
   `:9222`.

## Drive the chat over HTTP (the proven recipe)

Mint a user token via the documented exchange, get the cross-site session cookie, then
POST messages (no secrets printed):

- `POST {backendUrl}/addon/user/69bda6b317a0c5babe34b4fe/token` with header
  `X-Addon-Token: <installation token from the store>` → user token. **Use the OWNER
  member id above — NOT the install token's `user` claim** (that one 404s).
- `GET {url}/component/assistant?auth_token=<userToken>` → `Set-Cookie` session.
- `POST {url}/api/chat/messages` `{ "message": "…" }` with that cookie (JSON response),
  OR `POST {url}/api/chat/stream` for the NDJSON streaming variant.
- Confirm a risky preview: `POST {url}/api/confirmations/{previewId}/confirm` `{ "nonce" }`.
- Undo the last reversible action: `POST {url}/api/undo/{id}`.
- Ops view: `GET {url}/api/metrics` (per-action success/error/confirm rates, scoped to you).

(`scripts/live-confirm-flow.ts` does the token exchange + a full risky round-trip;
`--env-file=.env.server`.)

## Opt-in scripts worth knowing (all `--env-file=.env.server` where they hit the model)

- **Planner eval (the meter):** `npx tsx --env-file=.env.server scripts/eval-planner.ts
  --repeat=3` → pass-rate + consistency in tool mode; `--json-mode` for the A/B;
  `--only=<area>`. `scripts/eval-trend.ts` summarizes the trend over time.
- **Live exercisers (sacrificial workspace only):** `scripts/live-full.ts` (every action
  through preview→confirm→commit), `scripts/live-sweep.ts` (cleanup), `scripts/live-chat-tour.ts`
  (broad dogfood tour). See `CLAUDE.md` → Live Testing for the full list + env.

## Known gotchas (encoded in memory)

- Clockify **reserves a project name even after archive-then-delete** ("already exists" on
  re-create) — use unique `AIASSIST_SMOKE_*` names in tests and hard-delete leftovers.
- Dev-console session is short-lived → restore via the test-accounts tab (above).
- Webhooks (all) + custom-field CREATE + account-level `GET /workspaces` are blocked
  for the ADD-ON TOKEN CLASS regardless of scopes (NOT dev-only) — surfaced as an
  honest platform-restriction message at preview/call time; `workspace_get` uses the
  workspace-scoped route, which works.
- **Invoice line items** need a workspace-configured invoice item type (no API to list/create
  them); a fresh workspace has none → the add-on now warns in the **preview** and the total
  stays $0 until an admin configures one in Clockify → Invoices. Platform constraint.

## Human-gated / deferred (the only "open work" — needs the user)

1. **Stable hosting** — a fixed URL needs the named-tunnel-on-a-domain route (Cloudflare
   zone + `cloudflared tunnel login/create/route dns`) or a real deploy. User declined the
   zone for now.
2. **Prod security review + token rotation.**
3. **Prod AUDIT host `X-Addon-Token` clearance** — needs a captured prod token; run
   `scripts/host-auth-spike.ts` with `LIVE_ADDON_TOKEN`/`LIVE_BACKEND_URL` to settle it
   (dev cleanly reports "audit log not available", so this is prod-only).
