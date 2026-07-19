# Private-production performance gate

Run this only after the exact clean release candidate is deployed to the private
Railway service and the logged-in Clockify component is installed in a dedicated
sacrificial workspace. The admin policy must already grant `read_write` for
`work_structure`, and the current conversation must have no pending preview.

Use the secure launcher. It reads the installation credential from the parent
environment, finds an explicit active owner/admin through Clockify's role-bearing
workspace member endpoint, exchanges a short-lived user credential in memory,
and constructs the authenticated component address in memory. That address is
passed only in the performance child's environment: never argv, logs, a file,
the clipboard, evidence, or chat. Before any exchange, it accepts only a root HTTPS
`*.up.railway.app` origin and performs a redirect-blocked, credential-free `/version`
preflight bound to the exact checked-out SHA and archive hash. From a clean checkout
of the deployed commit:

```bash
test -z "$(git status --porcelain)"
export LIVE_CLOCKIFY=1
export LIVE_PERFORMANCE=1
export LIVE_SACRIFICIAL_WORKSPACE=1
export LIVE_RELEASE_SHA="$(git rev-parse HEAD)"
export LIVE_RELEASE_BUILD_HASH="$(git archive HEAD | shasum -a 256 | awk '{print $1}')"
export LIVE_WORKSPACE_ID="REPLACE_WITH_SACRIFICIAL_WORKSPACE_ID"
export LIVE_ADDON_BASE_URL="https://REPLACE_WITH_PRIVATE_RAILWAY_HOST"
export LIVE_BACKEND_URL="https://api.clockify.me/api"
export PERF_EVIDENCE_DIR="$(mktemp -d /tmp/ai-assistant-private-perf.XXXXXX)"
printf 'Paste the production installation token (input is hidden): '
IFS= read -r -s LIVE_ADDON_TOKEN
export LIVE_ADDON_TOKEN
printf '\n'
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run perf:private-production:secure
unset LIVE_ADDON_TOKEN
```

The launcher refuses to start unless Node 22 is active, the SHA equals local
`HEAD`, the checkout is clean, and the public release preflight passes before any
short-lived admin credential exists. The child receives a strict environment
allow-list that excludes `LIVE_ADDON_TOKEN`, `LIVE_BACKEND_URL`, and
`LIVE_ADDON_BASE_URL`; its sole credential-bearing value is `LIVE_COMPONENT_URL`.
The gate still requires an absolute off-worktree evidence directory, exact
version 1.0.0 SHA/build metadata, and `/api/me` for exactly `LIVE_WORKSPACE_ID`.
Chromium receives a second minimal environment that excludes the component
address.

Method and cleanup:

- 20 warm and 20 cold fast-4G component samples, 20 browser-local status samples,
  and 20 same-session history calls are recorded.
- The history session is filled with exactly 25 read-only turns, producing the
  supported 50-message restore window, then checked on every timed response.
- 20 confirmation samples create only randomly named `AIASSIST_PERF_` tags, obtain
  a destructive preview, and use the authenticated streaming button endpoint.
- Confirmation work runs in four five-resource cohorts. The four session
  rotations (one after history, then after confirmation samples 5, 10, and 15)
  keep every session below the default 30-turn/5-minute limit with retry and
  cleanup headroom.
- Each successful delete receipt must identify the exact created tag. If DeepSeek
  fails after creation, cleanup uses the safe-create undo handle directly, without
  the provider. No evidence is written unless all 20 deletions and zero pending
  previews are proven.

Only aggregate JSON and Markdown are written. They contain the release SHA,
sample counts, thresholds, p50/p95/max values, and cleanup counts—never the
component address, cookie, token, request text, response payload, nonce, resource
name, or operational identifier.
