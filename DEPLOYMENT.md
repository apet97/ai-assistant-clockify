# Deploying to Railway

The add-on is a single Express server (`npm start` → `dist/server/server.js`) that
serves the manifest, the embedded chat UI, the Clockify lifecycle/component
endpoints, and the chat API. It keeps all state in one SQLite file. Railway gives
it a **stable public URL**, which retires the dev quick-tunnel entirely (no more
URL rotation, no reinstall dance).

## The SDK is vendored — no prerequisite

`@apet97/clockify-addon-sdk` is a dependency on the request path (token signature
verification + manifest building). Its source lives in a sibling repo outside this
one, so a bare `file:../…` path wouldn't exist in the Railway build. Instead it is
**vendored as a committed tarball** at `vendor/apet97-clockify-addon-sdk-1.0.0.tgz`,
and `package.json` points the dependency at it:

```json
"@apet97/clockify-addon-sdk": "file:vendor/apet97-clockify-addon-sdk-1.0.0.tgz"
```

`npm ci` resolves it from the in-repo tarball (the lockfile pins its integrity
hash), so the Railway build is self-contained — no npm publish, account, or token
needed. **To re-vendor after an SDK change** (run from THIS directory):

```bash
# 1. Build the SDK from source, then pack the built artifact into vendor/.
( cd ../addon-ts-sdk/addon-sdk && npm ci && npm run build && \
  npm pack --pack-destination "$OLDPWD/vendor" )
#    (If ../addon-ts-sdk/addon-sdk has no "build" script, drop `npm run build`.)

# 2. If the SDK version changed, delete the OLD tarball and point package.json
#    at the new filename (else vendor/ accumulates stale tarballs):
#    rm vendor/apet97-clockify-addon-sdk-<OLD>.tgz
#    edit package.json: "file:vendor/apet97-clockify-addon-sdk-<NEW>.tgz"

# 3. Reinstall so package-lock.json re-pins the new tarball's integrity hash.
rm -rf node_modules
npm install

# 4. Prove the swap didn't break the request path (verify + a clean offline install).
npm run verify
rm -rf node_modules && npm ci

# 5. Commit BOTH the new vendor/*.tgz and the updated package.json + package-lock.json.
git add vendor/ package.json package-lock.json
```

(If you later publish the SDK to npm, swap the dependency to a version range like
`"^1.0.0"` and drop the `vendor/` tarball — see git history for the publish path.)

## 1. Create the Railway service

Railway auto-detects Nixpacks; `railway.json` pins the build/start/healthcheck
(build = `npm run build` (tsc + vite), start = `npm start`). Node is pinned to
**22.x** via `engines` (gets a `better-sqlite3` prebuild — no native compile).

**Dashboard:** New Project → Deploy from GitHub repo → `apet97/ai-assistant-clockify`.

**Railway CLI** (you have it installed):

```bash
railway login
railway init                 # new project  (or: railway link  for an existing one)
railway up                   # build + deploy the current dir via Nixpacks
railway domain               # generate the public URL -> use it as BASE_URL below
```

Note: `railway up` uploads this repo dir and runs `npm ci` in the container; the
SDK is vendored in-repo (`vendor/…tgz`), so the install is self-contained. After
`railway domain` gives you the URL, set `BASE_URL` to it (step 3) and redeploy.

## 2. Attach a Volume — REQUIRED (do not skip)

SQLite holds the **installation tokens, sessions, audit log, and pending
confirmations**. Railway's container filesystem is **ephemeral**: without a
volume the database is wiped on every redeploy/restart, which silently breaks
every existing Clockify install (the stored `X-Addon-Token` is gone and Clockify
does not resend it).

- Dashboard: Service → **Volumes** → add a volume, mount path `/data`.
- CLI: `railway volume add` (set the mount path to `/data` when prompted).
- Set `DATABASE_PATH=/data/ai-assistant.sqlite` (see env below).

## 3. Environment variables

Set these in the service **Variables** tab. `PORT` is injected by Railway — do
not set it.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `BASE_URL` | `https://<your-app>.up.railway.app` (the public domain Railway assigns) |
| `DATABASE_PATH` | `/data/ai-assistant.sqlite` (must be inside the mounted volume) |
| `CLOCKIFY_ADDON_KEY` | `ai-assistant` |
| `SESSION_SECRET` | a long random string — `openssl rand -hex 32` |
| `DATA_ENCRYPTION_KEY` | a strong random passphrase, **min 32 chars** (SHA-256-derived to the AES-256-GCM key — not raw hex) — `openssl rand -hex 32` gives 64 chars |
| `LLM_BASE_URL` | your OpenAI-compatible endpoint |
| `LLM_API_KEY` | the model API key |
| `LLM_MODEL` | the model name |

CLI equivalent: `railway variables --set "BASE_URL=https://…" --set
"DATABASE_PATH=/data/ai-assistant.sqlite" --set "SESSION_SECRET=…"` (etc.).

Optional knobs (defaults are fine): `LLM_PROVIDER=http`, `LLM_MODE=tool`,
`LLM_AGENTIC=1`, `LLM_TOOL_SELECT=1` (deterministic tool subsetting, **default on** —
the model sees only the message-relevant actions; eval-proven 100% on DeepSeek + both
Gemini tiers with ~61–65% fewer prompt tokens; set `=0` to roll back to the full
catalog), `COMMIT_TIMEOUT_MS` (Clockify commit/IO timeout in ms, default
120000 — **must be < 290000** so it stays below the idempotency claim TTL),
`RETENTION_DAYS` (chat-transcript + audit-log retention in days, default 90,
**min 30**; see [`PRIVACY.md`](./PRIVACY.md)). Leave `CLOCKIFY_ADDON_PUBLIC_KEY_PEM` **unset** — the platform
RS256 key is built in. Never set a real token here; the add-on receives its
install token from Clockify at runtime.

`DATA_ENCRYPTION_KEY_PREVIOUS` is rotation-only. Set the new key in
`DATA_ENCRYPTION_KEY` and the old key in `DATA_ENCRYPTION_KEY_PREVIOUS`; startup
transactionally re-encrypts every installation token. After a successful health
check, token-backed read, and verified backup, remove the previous key and redeploy.

`BASE_URL` must match the live domain exactly: it is the manifest `baseUrl` and
the session cookie is `SameSite=None; Secure; Partitioned`, so a mismatched or
non-HTTPS origin breaks the cross-site iframe.

## 4. Register the manifest in Clockify

After the first successful deploy + healthcheck:

1. Open the Clockify developer console → workspace **Add-ons**.
2. If a previous (tunnel) install exists, **uninstall** it first (type `UNINSTALL`).
3. **Insert link** → `https://<your-app>.up.railway.app/manifest` → **INSTALL**.

Clockify POSTs `/lifecycle/installed` to the new URL; the install row + token land
in the volume-backed DB. Verify: open the **AI Assistant** sidebar entry → the
embedded chat loads and a read action returns a receipt.

## 5. Verify the deploy

- `GET https://<your-app>.up.railway.app/live` → `200` while the process can serve.
- `GET https://<your-app>.up.railway.app/health` → `200 {"ok":true}` only while
  ready. It performs a bounded committed SQLite probe, so draining, locked,
  read-only, full, or closed storage returns `503`.
- `GET https://<your-app>.up.railway.app/manifest` → `200` (the add-on manifest).
- Sidebar chat loads; a read ("list my projects") returns a receipt; a risky write
  shows a preview + Confirm button.
- With the stable URL, you can finally answer the prod **AUDIT-host** question: run
  `scripts/host-auth-spike.ts` with a captured prod `LIVE_ADDON_TOKEN`.

## Operational constraints

- **Run a single instance.** The chat/new-chat rate limiters are in-process (per
  Railway instance) by design (src/routes/rate-limit.ts). Scaling to >1 instance
  multiplies the effective caps and weakens the paid-loop abuse damping. If you
  must scale out, move the limiter to the shared SQLite (or a shared store) first.
- **SESSION_SECRET keys two things.** It signs the session cookie AND hashes the
  one-use confirmation nonce. Rotating it invalidates ALL live sessions AND ALL
  live pending confirmations at once — expect admins to re-open the panel and
  re-preview after a rotation.
- Clockify host calls are governed per workspace at 10 requests/second, burst 10,
  concurrency 4, one mutation at a time, and 60 host calls per chat/resume turn.
  A `429` pauses new dispatches according to `Retry-After`; writes are never retried.

## Backup, restore, and point-in-time recovery

Back up the live SQLite database with its online backup API; do not copy the live
`.sqlite`, `-wal`, and `-shm` files independently:

```bash
npm run db:backup -- /data/ai-assistant.sqlite /data/backups/ai-assistant-$(date +%Y%m%dT%H%M%S).sqlite
```

The command runs `PRAGMA integrity_check`, creates a consistent snapshot, and writes
`.sha256` plus JSON metadata sidecars. Copy all three files to encrypted off-volume
storage. Keep daily backups for 30 days and one monthly backup for the applicable
legal/contractual period; never retain them longer than the source data policy.

Restore only while the service is stopped/draining:

```bash
RESTORE_DATABASE=YES npm run db:restore -- backup.sqlite restored.sqlite
```

The restore refuses a checksum mismatch or failed integrity check and will not
overwrite an existing target unless `RESTORE_OVERWRITE=YES`. Prefer restoring to a
new path, start a one-off instance against it, verify `/health`, schema version, and
a token-backed read, then atomically switch `DATABASE_PATH`. A point-in-time recovery
can restore only to a completed backup timestamp; application rows written after that
snapshot may have host-side effects, so all recovered `executing` operations become
`outcome_unknown` and must be reconciled before another write.

Run and record a restore drill before launch and at least quarterly. The automated
hardening pass verified a local backup/checksum/restore/data-read drill; production
volume recovery remains an operator gate.

## Required alerts

Alert on readiness `503`, fatal/draining exits, retention backlog or repeated prune
failure, SQLite `BUSY`/`FULL`/read-only errors, operation `outcome_unknown`, sustained
Clockify `429`/5xx responses, model-provider failures, and artifact oversize rejects.
Do not include prompts, headers, tool results, or tokens in alert payloads.

## Still human-gated (unchanged by hosting)

- Prod security review + token rotation before real users.
- Prod AUDIT-host `X-Addon-Token` clearance (the spike above).
