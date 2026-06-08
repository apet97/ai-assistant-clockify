# Next-session kickoff — AI Assistant add-on (live testing)

Copy the block below into a fresh Claude Code session to continue testing the
**live** Clockify "AI Assistant" add-on. Runtime values (tunnel URL especially)
are **ephemeral** — verify them first; the prompt tells you how to bring the
environment back up.

---

Continue the Clockify "AI Assistant" add-on. Repo:
`/Users/15x/Downloads/WORKING/addons-me/ai-assistant-addon` (branch `main`, pushed).
Read `CLAUDE.md` + `AGENTS.md` first, and recall the project memories
(`clockify-addon-public-key-builtin`, `clockify-api-base-resolution`,
`clockify-dev-console-login-and-reinstall`). V1 + full REST parity are COMPLETE;
`npm run verify` is green at **447 tests**. The risky-write confirm flow and the
audit-host fix are both done, committed, and proven live last session.

## Bring the live environment up (do this first)

1. **Server + tunnel** are managed by `scripts/dev-tunnel.sh`. Run
   `scripts/dev-tunnel.sh status`.
   - Healthy + `BASE matches yes` → you're good; note the printed tunnel URL.
   - Down or `BASE matches NO` → run `scripts/dev-tunnel.sh up` (starts/reuses the
     quick tunnel, writes `BASE_URL` into `.env.server`, restarts the server, prints
     the URL). DeepSeek is wired via `.env.server` `LLM_*` (api.deepseek.com).
   - Last session's URL was `https://jimmy-excluding-trans-garmin.trycloudflare.com`
     — **assume it has rotated**; `up`/`status` prints the current one.
2. **If the tunnel URL changed, re-register the manifest** (Clockify pins the
   component `baseUrl` at install). Restore the dev-console session via the **CAKE
   test-accounts tab** in Debug Chrome (`developer.marketplace.cake.com/test-accounts`
   → **"Log in as" John Owner**, Workspace Owner — no password). Then workspace
   settings → Add-ons → AI Assistant → **Uninstall** (the dropdown "Uninstall" only
   fires via a real DOM `.click()` via `agent-browser eval`; in the modal type
   `UNINSTALL`), then paste `<url>/manifest` into "Insert link" → **INSTALL**. Verify
   the DB install row's `updated_at` jumps to now and `status=active`.
3. **Workspace:** dev "Marketplace Workspace" `69bda6b317a0c5babe34b4ff`; owner member
   id `69bda6b317a0c5babe34b4fe`. Drive the browser with `agent-browser` on Debug
   Chrome `:9222`. Marketplace docs are LOCAL at
   `addons-me/mileage-for-clockify/addon-expenses-rest-api/MARKETPLACE_OCS/`.

## Drive the chat over HTTP (the proven recipe)

Mint a user token via the documented exchange, get the cross-site session cookie,
then POST messages (no secrets printed):

- `POST {backendUrl}/addon/user/69bda6b317a0c5babe34b4fe/token` with header
  `X-Addon-Token: <installation token from the store>` → user token. **Use the OWNER
  member id above — NOT the install token's `user` claim** (that one 404s).
- `GET {url}/component/assistant?auth_token=<userToken>` → `Set-Cookie` session.
- `POST {url}/api/chat/messages` `{ "message": "…" }` with that cookie.
- Confirm a risky preview: `POST {url}/api/confirmations/{previewId}/confirm` `{ "nonce" }`.

(`scripts/live-confirm-flow.ts` does all of this end-to-end; `--env-file=.env.server`.)

## What already works live (re-smoke if you want)

Reads (list tags/projects), `assistant_show_permissions`, safe write
(`clockify_tags_create`), risky write (`clockify_tags_delete` → preview →
button-confirm), and the audit question returns the **clean** "Audit log is not
available in this Clockify environment" error (not a crash).

## TASKS — fix the two live planner quirks (TDD; keep `npm run verify` green)

1. **One-turn "create a project AND start a timer on it" starts a BARE,
   unattached timer** (`entry.projectId` empty). The planner runs one model call and
   can't reference the not-yet-created project id in the same turn. Given the id in a
   follow-up turn it attaches correctly. Fix one of:
   - a planner-prompt nudge to sequence create → then start the timer in a follow-up
     when the project doesn't exist yet, OR
   - a combined workflow action (or extend `create_work_package`) that creates/reuses
     the project and starts the timer on it in one harness step (resolves the id
     server-side, no model id-juggling). Add a mocked-fetch test pinning the request
     shape (timer carries the new `projectId`).
2. **Tag delete sometimes loses its `id` arg** → `invalid_args: Required`, so no
   preview fires. Tighten the catalog description / planner guidance so the model
   reliably lists→resolves→passes `id` (or accept name + resolve in the handler).

## Known gotchas (encoded in memory)

- Clockify **reserves a project name even after archive-then-delete** ("already
  exists" on re-create) — use unique names in tests and hard-delete leftovers.
- Dev-console session is short-lived → restore via the test-accounts tab (above).
- Quick-tunnel URL is random per `cloudflared` start; `dev-tunnel.sh up` is idempotent
  (reuses a healthy tunnel, so the URL only changes on `restart`/crash).

## Constraints

Keep the stack simple (TS/Express/Vite/SQLite/Zod/Vitest). No React/Next/Prisma/Redis.
Don't modify sibling repos. Write the failing test first. Commit in focused chunks and
push to `main`. Live tests are opt-in against the sacrificial dev workspace only; never
commit or print tokens/cookies.

## Deferred / not blocking

Prod AUDIT host `X-Addon-Token` clearance (needs a captured prod token; dev cleanly
reports "not available"). A truly fixed tunnel URL needs the named-tunnel-on-a-domain
route (Cloudflare zone + `cloudflared tunnel login/create/route dns`) — user declined
for now.
