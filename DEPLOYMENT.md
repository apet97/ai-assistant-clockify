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
needed. To re-vendor after an SDK change:

```bash
( cd ../addon-ts-sdk/addon-sdk && npm pack --pack-destination "$OLDPWD/vendor" )
# bump the filename in package.json if the version changed, then: npm install
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
`LLM_AGENTIC=1`, `COMMIT_TIMEOUT_MS` (Clockify commit/IO timeout in ms, default
120000 — **must be < 290000** so it stays below the idempotency claim TTL).
Leave `CLOCKIFY_ADDON_PUBLIC_KEY_PEM` **unset** — the platform
RS256 key is built in. Never set a real token here; the add-on receives its
install token from Clockify at runtime.

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

- `GET https://<your-app>.up.railway.app/manifest` → `200` (this is the Railway
  healthcheck path).
- Sidebar chat loads; a read ("list my projects") returns a receipt; a risky write
  shows a preview + Confirm button.
- With the stable URL, you can finally answer the prod **AUDIT-host** question: run
  `scripts/host-auth-spike.ts` with a captured prod `LIVE_ADDON_TOKEN`.

## Still human-gated (unchanged by hosting)

- Prod security review + token rotation before real users.
- Prod AUDIT-host `X-Addon-Token` clearance (the spike above).
