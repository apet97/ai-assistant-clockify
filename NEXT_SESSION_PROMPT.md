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
`npm run verify` is green at **461 tests**. The risky-write confirm flow, the
audit-host fix, AND the two live planner quirks are all done, committed, and proven
live (the planner quirks via `scripts/live-planner-quirks.ts`, PASS=9).

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
available in this Clockify environment" error (not a crash). PLUS (smoothed
2026-06-08): one-turn **"create a project and start a timer on it"** attaches the
timer to the new project (`clockify_create_work_package` + `startTimer`), and
**"delete the tag named X"** resolves the name → preview → confirm. Re-smoke both
with `npx tsx --env-file=.env.server scripts/live-planner-quirks.ts` (PASS=9).

## TASKS — both live planner quirks are DONE (kept here for context)

Resolved last session (TDD, `npm run verify` green at 461, proven live):

1. **One-turn "create a project AND start a timer on it"** — extended
   `clockify_create_work_package` with an optional `startTimer` that
   creates/reuses the project (and task) and starts the timer on that id
   server-side (gated by `time_tracking`; warns + skips when read-only). Live debug
   showed the planner emits `startTimer: true` + a flat `projectName`, so the schema
   accepts a boolean OR object and a `z.preprocess` folds bare-string/flat `*Name`
   shapes into the nested form. Mocked-fetch test pins the timer carries the new id.
2. **Tag delete losing its `id`** — `clockify_tags_delete` now accepts an exact
   `name` and resolves it (list→`matchByName`, clarify on none/many), id pinned into
   the operation. Planner prompt reworded to pass the name directly (not list-first).

No open implementation tasks. If continuing: marketplace submission prep, or the
deferred prod-AUDIT-host clearance (below).

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
