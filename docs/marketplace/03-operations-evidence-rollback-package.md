# Release, incident, reconciliation, and rollback runbook - version 1.0.0

This is an executable operator runbook. It does not grant release authority and it does
not treat application rollback as reversal of a Clockify effect. Record every release
result in [`evidence/release-candidate.md`](./evidence/release-candidate.md).

The **source candidate** is the clean commit containing all executable code, listing
media, and the passed media-review artifact. It is the commit evaluated with DeepSeek and
deployed to Railway. The reviewed PR/evidence commit may equal that SHA or be a descendant
whose entire diff is checked by the validators as allowlisted non-executable evidence.
Never deploy the descendant merely because it is the PR head.

## Canonical production release order

1. Freeze the source candidate on `codex/marketplace-1.0.0` and record its full commit SHA
   and archive hash. It must already contain the final generated media and passed review.
2. Run all machine, browser, DeepSeek, performance, lifecycle, and recovery gates for
   that SHA. Do not reuse results from an ancestor or an uncommitted worktree.
3. Create a checksum-verified SQLite backup and copy the database, SHA-256 sidecar, and
   metadata sidecar to encrypted off-volume storage.
4. Confirm the backup timestamp and list all nonterminal operation runs. Settle or
   explicitly block any unknown operation before release.
5. Deploy the exact candidate to the single-instance private Railway production service.
6. Verify `/live`, `/health`, `/manifest`, version 1.0.0, base URL, admin-only component,
   icon, and generated scope contract.
7. Exercise the real Clockify iframe as owner/admin, then verify member denial. Complete
   first run, read, safe write, risky preview/confirm/cancel, undo, history, reload, PDF
   download, and synthetic-resource cleanup.
8. Capture release performance and provider cache-token evidence without prompts,
   credentials, customer data, or raw model responses.
9. Push the branch, open the pull request, and require green CI, dependency review,
   gitleaks, CodeQL, and an engineering review with no unresolved P1/P2 finding.
10. Reconfirm that `/version`, deployment, DeepSeek evaluation, media-binding artifact,
    browser proof, and recovery proof identify the source-candidate SHA/archive. If the
    reviewed PR head differs, require ancestor and evidence-only-diff validation. Stop
    before the Marketplace **Submit for Review** action.

The encrypted backup and isolated restore are a hard precondition, not evidence captured
after deployment. Immediately before upload, export the exact paths created by the
backup/restore section and rerun the executable stop gate. It verifies APFS/FileVault
encryption, file containment, the current database and both sidecars, the measured restore
schema, and exact release/artifact identity. It also captures the gate clock at execution
and requires both backup completion and restore readiness to be no more than one hour old;
future-dated or misordered backup/incident/drill/readiness timestamps fail closed. **STOP:
do not run Railway upload** when this command exits nonzero:

```bash
export RECOVERY_VOLUME=/Volumes/AIASSIST_RECOVERY
export PREDEPLOY_BACKUP_PATH="$LOCAL_BACKUP"
export PREDEPLOY_BACKUP_CHECKSUM_PATH="$LOCAL_BACKUP.sha256"
export PREDEPLOY_BACKUP_METADATA_PATH="$RELEASE_METADATA"
export PREDEPLOY_RESTORE_EVIDENCE_PATH="$RESTORE_EVIDENCE"
export RELEASE_SERVER_ARTIFACT_SHA256="$(node -p \
  'JSON.parse(require("node:fs").readFileSync("dist/release-artifact-manifest.json", "utf8")).serverArtifactSha256')"
npm run --silent gate:predeploy-backup
```

The current DeepSeek capability probe, baseline, candidate, and focused runs are a settings-only
comparison from the **same exact clean source-candidate SHA** and pinned endpoint. They run on
Node 22, write only to the encrypted external evidence directory, recheck the clean source after
the provider calls, and reject mixed-tier or experiment overrides. Each `--repeat=5` artifact
contains five ordered complete cohorts of the entire configured corpus. The exact-schema,
recursive-secret-free validator rejects stale/reordered windows, a changed source or endpoint,
unsupported fields, missing cache telemetry, any safety failure, or a candidate whose median is
not at least as fast as every distinct passing supported setting. See `DEPLOYMENT.md` for the
canonical commands; the capability probe and all four raw aggregates are hash-bound into
`binding.candidate.testedSha` before deployment.

## Exact online backup and isolated restore drill

Mount and unlock an encrypted APFS/FileVault volume at
`/Volumes/AIASSIST_RECOVERY`. It is explicit off-Railway-volume storage and must not be a
cloud-sync folder. Keep the production app online for the SQLite online backup:

```bash
set -euo pipefail
railway --version                         # required release tool: Railway CLI 5.27.0
: "${RELEASE_SHA:?exact release SHA is required}"
: "${RELEASE_BUILD_HASH:?exact release build hash is required}"
export RELEASE_SHA RELEASE_BUILD_HASH
RECOVERY_VOLUME=/Volumes/AIASSIST_RECOVERY
test -d "$RECOVERY_VOLUME"
diskutil info "$RECOVERY_VOLUME" | grep -Eq '(FileVault|Encrypted):[[:space:]]+Yes'
umask 077
DRILL_ID="$(date -u +%Y%m%dT%H%M%SZ)"
REMOTE_NAME="ai-assistant-${DRILL_ID}.sqlite"
REMOTE_BACKUP="/data/backups/${REMOTE_NAME}"
LOCAL_DIR="${RECOVERY_VOLUME}/ai-assistant/${RELEASE_SHA}/${DRILL_ID}"
mkdir -p "$LOCAL_DIR"

BACKUP_BOUNDARY_FILE="$LOCAL_DIR/pre-backup-boundary.txt"
npm run --silent db:capture-backup-boundary -- "$BACKUP_BOUNDARY_FILE"

# In the authenticated Railway dashboard Console for the exact production service,
# substitute the resolved DRILL_ID and enter each line separately:
mkdir -p /data/backups
npm run --silent db:backup -- /data/ai-assistant.sqlite \
  /data/backups/ai-assistant-<DRILL_ID>.sqlite
chmod 600 /data/backups/ai-assistant-<DRILL_ID>.sqlite \
  /data/backups/ai-assistant-<DRILL_ID>.sqlite.sha256 \
  /data/backups/ai-assistant-<DRILL_ID>.sqlite.json
```

Railway does not publish an authoritative `ssh.railway.com` host-key set. Do not use
`ssh-keyscan`, `StrictHostKeyChecking=no`, `accept-new`, or a first-seen key for this
database. In the Railway dashboard **Console**, open **Files**, browse `Root` -> `data` ->
`backups`, and Save As each exact file directly to its `.partial` path inside `LOCAL_DIR`.
Never run `env`, `set`, `printenv`, or `sh -lc`. Finalize the browser transfer with:

```bash
LOCAL_BACKUP="$LOCAL_DIR/$REMOTE_NAME"
for suffix in "" ".sha256" ".json"; do
  target_path="${LOCAL_BACKUP}${suffix}"
  partial_path="${target_path}.partial"
  test -f "$partial_path"
  chmod 600 "$partial_path"
  mv "$partial_path" "$target_path"
  test "$(stat -f '%Lp' "$target_path")" = 600
done
```

If and only if an approved SSH host-key trust record exists, this Railway CLI 5.27.0
SFTP transfer may replace that browser loop. Its release-only key must be in an isolated
`ssh-agent`, registered by fingerprint/comment, and removed from both Railway and the
agent afterward because key scope is broader than one project:

```bash
LOCAL_BACKUP="$LOCAL_DIR/$REMOTE_NAME"
for suffix in "" ".sha256" ".json"; do
  target_path="${LOCAL_BACKUP}${suffix}"
  partial_path="${target_path}.partial"
  railway service files -p fb1fa3c6-cc28-40d8-b985-2a7ee7051304 \
    -s 2656670e-39a5-40f3-af5c-56dfc637552f \
    -e 45300bdc-788b-4f63-8749-5a8f7e46b774 \
    download "${REMOTE_BACKUP}${suffix}" "$partial_path" --json >/dev/null
  chmod 600 "$partial_path"
  mv "$partial_path" "$target_path"
done
```

After either transfer path, verify the checksum and bind legacy metadata when required:

```bash
chmod 600 "$LOCAL_BACKUP" "$LOCAL_BACKUP.sha256" "$LOCAL_BACKUP.json"
(cd "$LOCAL_DIR" && shasum -a 256 -c "$REMOTE_NAME.sha256")

METADATA_FORMAT="$(node -p \
  'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).format' \
  "$LOCAL_BACKUP.json")"
case "$METADATA_FORMAT" in
  1)
    RELEASE_METADATA="$LOCAL_BACKUP.release.json"
    npm run --silent db:bind-legacy-backup-metadata -- \
      "$LOCAL_BACKUP" "$LOCAL_BACKUP.sha256" "$LOCAL_BACKUP.json" \
      "$BACKUP_BOUNDARY_FILE" "$RELEASE_METADATA"
    ;;
  2) RELEASE_METADATA="$LOCAL_BACKUP.json" ;;
  *) printf 'Unsupported backup metadata format: %s\n' "$METADATA_FORMAT" >&2; exit 1 ;;
esac
chmod 600 "$RELEASE_METADATA"
```

The v7 production tool's format-1 sidecar lacks `dataAsOf`. The candidate binder never
rewrites it: it verifies the backup/checksum/legacy byte binding and emits a separate
format-2 sidecar from the UTC boundary captured before the remote backup began. A later
timestamp cannot be substituted without the binder failing closed.

The 1.0.0 drill is a data-encryption-key rotation drill. Set the new key in
`DATA_ENCRYPTION_KEY` and the old key in `DATA_ENCRYPTION_KEY_PREVIOUS` through the
approved encrypted recovery location without echoing or listing Railway variables. Start RTO immediately before restoring. The simulated incident time
minus format-2 metadata's conservative pre-snapshot `dataAsOf` is RPO. The verifier copies
the caller-owned restore to a private mode-0600 clone, verifies checksum, integrity, and
the supported v7/v8 source schema read-only, blocks redirects, and makes one authenticated
`GET /user` before migration. It then boots the exact built
`dist/server/server.js` entrypoint against only the private clone, including
the real v7-to-v8 Store migration, interrupted-deletion completion, and production
read-only startup reconciliation. After shutdown the verifier independently requires v8
critical tables/columns, integrity, and an available writer lock. Before spawn,
`npm run build` in this exact Git checkout writes a
deterministic manifest that binds
the complete generated `dist/server` + `dist/ui` tree hash to the exact Git source-candidate SHA and its
`git archive` SHA-256. The verifier independently recomputes the archive and runtime-artifact
hashes and requires either the exact candidate checkout or a clean descendant whose
entire diff is allowlisted immutable evidence. Arbitrary `RELEASE_SHA`/
`RELEASE_BUILD_HASH` strings, dirty source, non-evidence descendants, stale manifests,
and changed artifact bytes all fail before the child starts. The child binds loopback
port 0 and reports it over IPC, requires `GET /health` 200, records that readiness instant, stops, then
passes database reopen, integrity, and writer-lock checks. The one-off app makes no model
request, may write only to its automatically deleted private clone, and never serializes a token, identifier, URL, response
body, or child-process log:

```bash
RESTORE_INCIDENT_AT="$(node -p 'new Date().toISOString()')"
RESTORE_DRILL_STARTED_AT="$RESTORE_INCIDENT_AT"
export RESTORE_INCIDENT_AT RESTORE_DRILL_STARTED_AT
ISOLATED_DIR="$LOCAL_DIR/isolated"
RESTORED_PATH="$ISOLATED_DIR/restored.sqlite"
RESTORE_EVIDENCE="$LOCAL_DIR/restore-verification.json"
mkdir -p "$ISOLATED_DIR"
test -f dist/server/server.js

if [ -z "${DATA_ENCRYPTION_KEY:-}" ]; then
  printf 'DATA_ENCRYPTION_KEY (new production key): ' >&2
  IFS= read -r -s DATA_ENCRYPTION_KEY
  printf '\n' >&2
fi
if [ -z "${DATA_ENCRYPTION_KEY_PREVIOUS:-}" ]; then
  printf 'DATA_ENCRYPTION_KEY_PREVIOUS (old production key): ' >&2
  IFS= read -r -s DATA_ENCRYPTION_KEY_PREVIOUS
  printf '\n' >&2
fi
export DATA_ENCRYPTION_KEY DATA_ENCRYPTION_KEY_PREVIOUS

RESTORE_DATABASE=YES npm run --silent db:restore -- "$LOCAL_BACKUP" "$RESTORED_PATH"
npm run --silent db:verify-restore -- \
  "$RESTORED_PATH" "$LOCAL_BACKUP.sha256" "$RELEASE_METADATA" \
  >"$RESTORE_EVIDENCE"
node -e '
  const evidence = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const drillStarted = Date.parse(evidence.recovery?.drillStartedAt);
  const ready = Date.parse(evidence.recovery?.readinessConfirmedAt);
  const incident = Date.parse(evidence.recovery?.incidentAt);
  const dataAsOf = Date.parse(evidence.recovery?.dataAsOf);
  if (evidence.conclusion !== "passed" || !evidence.recovery ||
      evidence.checks.tokenBackedRead.status !== "passed" ||
      evidence.checks.applicationReadiness.status !== "passed" ||
      evidence.checks.applicationReadiness.endpoint !== "GET /health" ||
      evidence.checks.applicationReadiness.httpStatus !== 200 ||
      evidence.checks.applicationReadiness.serverArtifact !== "dist/server/server.js" ||
      evidence.checks.applicationReadiness.releaseSha !== process.env.RELEASE_SHA ||
      evidence.checks.applicationReadiness.releaseBuildHash !== process.env.RELEASE_BUILD_HASH ||
      !/^[a-f0-9]{64}$/.test(evidence.checks.applicationReadiness.serverArtifactSha256) ||
      evidence.checks.applicationReadiness.shutdownVerification?.databaseIntegrity !== "ok" ||
      evidence.checks.applicationReadiness.shutdownVerification?.writerLock !== "available" ||
      evidence.checks.integrity.sourceResult !== "ok" ||
      evidence.checks.integrity.migratedResult !== "ok" ||
      ![7, 8].includes(evidence.checks.schema.sourceUserVersion) ||
      evidence.checks.schema.userVersion !== 8 ||
      evidence.checks.schema.migration !==
        (evidence.checks.schema.sourceUserVersion === 8 ? "not_required" : "candidate_private_clone") ||
      evidence.checks.metadata.format !== 2 ||
      !Number.isFinite(drillStarted) || !Number.isFinite(ready) ||
      !Number.isFinite(incident) || !Number.isFinite(dataAsOf) ||
      evidence.recovery.rtoMs !== ready - drillStarted ||
      evidence.recovery.rpoMs !== incident - dataAsOf) process.exit(1);
' "$RESTORE_EVIDENCE"
shasum -a 256 "$RESTORE_EVIDENCE"
unset DATA_ENCRYPTION_KEY DATA_ENCRYPTION_KEY_PREVIOUS
```

Attach the secret-free evidence and hash to the release SHA, then remove only the
isolated restored candidate and the three explicit Railway temporary files. Retain the
local backup set under the approved retention schedule:

```bash
case "$RESTORED_PATH" in "$LOCAL_DIR"/isolated/*) ;; *) exit 64 ;; esac
rm -f -- "$RESTORED_PATH" "$RESTORED_PATH-wal" "$RESTORED_PATH-shm"
rmdir "$ISOLATED_DIR"

case "$REMOTE_BACKUP" in /data/backups/ai-assistant-*.sqlite) ;; *) exit 64 ;; esac
# Run in the authenticated Railway dashboard Console after substituting the same DRILL_ID.
rm -f -- /data/backups/ai-assistant-<DRILL_ID>.sqlite \
  /data/backups/ai-assistant-<DRILL_ID>.sqlite.sha256 \
  /data/backups/ai-assistant-<DRILL_ID>.sqlite.json
test ! -e /data/backups/ai-assistant-<DRILL_ID>.sqlite && \
  test ! -e /data/backups/ai-assistant-<DRILL_ID>.sqlite.sha256 && \
  test ! -e /data/backups/ai-assistant-<DRILL_ID>.sqlite.json
```

If the conditional CLI/SFTP path was used, remove its exact registered fingerprint and
private key from the agent, then require the unique release-key name to be absent:

```bash
railway ssh keys remove "$RELEASE_KEY_FINGERPRINT"
ssh-add -d "$RELEASE_KEY"
! railway ssh keys list | grep -F "$RELEASE_KEY_NAME"
```

The drill never changes production `DATABASE_PATH` and never mutates Clockify. For an
actual restore, drain the service, restore to a new path, run the same verification, and
switch paths only after reconciliation clears newer dispatched host effects.

## Exact Railway CLI 5.27.0 release identity and deploy

### Conditional thinking-disabled bootstrap

If the final binding's `modelConfiguration.thinkingMode` is `"disabled"` but the current
production service has no `LLM_THINKING_MODE`, set it once in the protected Railway
Variables UI and accept exactly one current-source bootstrap deployment. Do not use a CLI
variable mutation or begin the checked transaction. Require
`/version.modelConfiguration.thinkingMode` to equal `disabled`, `/health` 200, and a real
token-backed read. Then invalidate every earlier operational evidence artifact and take
an entirely fresh backup, restore drill, and predeploy gate. The default/unset path keeps
`LLM_THINKING_MODE` absent and does not bootstrap.

### Release-candidate checked transaction

Only after the encrypted-backup stop gate above passes, bind Railway's public `/version`
response to the exact archive uploaded by `railway up`; neither a deployment timestamp nor
a successful health check is source identity:

```bash
set -euo pipefail
: "${BASE_URL:?Set BASE_URL to the deployed production HTTPS origin before release}"
BASE_URL="$(npm run --silent release:validate-base-url -- "$BASE_URL")"
export BASE_URL
test -z "$(git status --porcelain --untracked-files=all)"
DEEPSEEK_BINDING_PATH="${DEEPSEEK_BINDING_PATH:-evidence/performance/deepseek-release-binding.json}"
EXPECTED_MODEL_CONFIGURATION="$(node -e '
  const binding = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(JSON.stringify(binding.modelConfiguration));
' "$DEEPSEEK_BINDING_PATH")"
SELECTED_LLM_MODEL="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).model)' "$EXPECTED_MODEL_CONFIGURATION")"
SELECTED_REASONING_EFFORT="$(node -e '
  const value = JSON.parse(process.argv[1]).reasoningEffort;
  process.stdout.write(value === null ? "unset" : value);
' "$EXPECTED_MODEL_CONFIGURATION")"
SELECTED_THINKING_MODE="$(node -e '
  const value = JSON.parse(process.argv[1]).thinkingMode;
  process.stdout.write(value === "disabled" ? "disabled" : "unset");
' "$EXPECTED_MODEL_CONFIGURATION")"
export EXPECTED_MODEL_CONFIGURATION SELECTED_LLM_MODEL SELECTED_REASONING_EFFORT SELECTED_THINKING_MODE
RELEASE_SHA="$(node -e '
  const binding = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(binding.candidate.testedSha);
' "$DEEPSEEK_BINDING_PATH")"
printf '%s' "$RELEASE_SHA" | grep -Eq '^[0-9a-f]{40}$'
git cat-file -e "$RELEASE_SHA^{commit}"
git merge-base --is-ancestor "$RELEASE_SHA" HEAD
RELEASE_BUILD_HASH="$(git archive "$RELEASE_SHA" | shasum -a 256 | awk '{print $1}')"
export RELEASE_SHA RELEASE_BUILD_HASH
RELEASE_STAGING="$(mktemp -d)"
trap 'rm -rf -- "$RELEASE_STAGING"' EXIT
git archive "$RELEASE_SHA" | tar -xf - -C "$RELEASE_STAGING"
RELEASE_SOURCE_BINDING_SHA256="$(npx tsx scripts/release-source-binding.ts --write "$RELEASE_STAGING")"
export RELEASE_SOURCE_BINDING_SHA256
test "${#RELEASE_SOURCE_BINDING_SHA256}" -eq 64

export RELEASE_STAGING
# This checked transaction runs gate:predeploy-backup before any variable
# mutation, snapshots only allowlisted nonsecret release/model settings, and
# restores their prior presence/value if Railway upload fails.
# STOP: do not run Railway upload if the checked transaction's backup/restore gate fails.
npm run --silent deploy:private-production

VERSION_JSON="$(curl --fail --silent --show-error "$BASE_URL/version")"
node -e '
  const value = JSON.parse(process.argv[1]);
  const expectedModel = JSON.parse(process.env.EXPECTED_MODEL_CONFIGURATION);
  const modelKeys = ["provider", "model", "endpointSha256", "mode", "agentic", "toolSelect", "reasoningEffort", "thinkingMode"];
  const actualModel = value.modelConfiguration;
  if (value.version !== "1.0.0" || value.releaseSha !== process.env.RELEASE_SHA ||
      value.buildHash !== process.env.RELEASE_BUILD_HASH ||
      value.sourceRelationship !== "source_bound_builder" ||
      value.sourceBindingSha256 !== process.env.RELEASE_SOURCE_BINDING_SHA256 ||
      value.serverArtifactSha256 !== process.env.RELEASE_SERVER_ARTIFACT_SHA256 ||
      !actualModel || Object.keys(actualModel).length !== modelKeys.length ||
      modelKeys.some((key) => actualModel[key] !== expectedModel[key])) process.exit(1);
' "$VERSION_JSON"
```

If a selected reasoning or thinking setting is `unset`, the corresponding Railway
variable must already be absent. Remove it in the protected Variables UI, repeat the
backup gate if that change deployed anything, and rerun the complete checked transaction.
Do not hand-run `railway variable set` before the gate.

The pre-upload binding is computed independently from the candidate's Git blob IDs,
executable modes, paths, and archive. The Git-less Railway prebuild recomputes the
canonical uploaded source tree before compilation and refuses any missing, added, or
changed source byte. It records the complete generated `dist/server` + `dist/ui` tree hash; production startup
rehashes those trees before database/provider initialization. Record the deployment id,
full SHA, archive hash, source-binding hash, runtime-artifact hash, and secret-free
`/version`. Abort live testing when any value is null or differs.

After health and a real token-backed read, repeat the online backup, encrypted transfer,
bind, restore, and token-backed verification with the new `DATA_ENCRYPTION_KEY` and
`DATA_ENCRYPTION_KEY_PREVIOUS` explicitly unset. Only after that second restore passes may
the previous variable be removed and its single resulting Railway deployment accepted.
Recheck exact `/version`, `/health`, and a token-backed read before remote cleanup.

### Postdeploy current-key-only second backup and restore

After the deployed startup has re-encrypted installations and the live health plus
token-backed read pass, take a completely separate online backup. Use a new
`POSTDEPLOY_DRILL_ID`, new local directory, new metadata, new restored path, and new
evidence path; none may alias the predeploy drill. Before opening Railway Files, prepare
the distinct local destination in the evidence checkout:

```bash
set -euo pipefail
POSTDEPLOY_DRILL_ID="${POSTDEPLOY_DRILL_ID:?Set the distinct postdeploy drill id}"
POSTDEPLOY_LOCAL_DIR="$RECOVERY_VOLUME/ai-assistant/$RELEASE_SHA/postdeploy-$POSTDEPLOY_DRILL_ID"
POSTDEPLOY_LOCAL_BACKUP="$POSTDEPLOY_LOCAL_DIR/ai-assistant-postdeploy-$POSTDEPLOY_DRILL_ID.sqlite"
POSTDEPLOY_RELEASE_METADATA="$POSTDEPLOY_LOCAL_BACKUP.json"
POSTDEPLOY_ISOLATED_DIR="$POSTDEPLOY_LOCAL_DIR/isolated-current-key"
POSTDEPLOY_RESTORED_PATH="$POSTDEPLOY_ISOLATED_DIR/restored-current-key.sqlite"
POSTDEPLOY_RESTORE_EVIDENCE="$POSTDEPLOY_LOCAL_DIR/restore-current-key.json"
test ! -e "$POSTDEPLOY_LOCAL_DIR"
mkdir -m 700 "$POSTDEPLOY_LOCAL_DIR"
test "$(stat -f '%Lp' "$POSTDEPLOY_LOCAL_DIR")" = 700
test "$(stat -f '%u' "$POSTDEPLOY_LOCAL_DIR")" = "$(id -u)"
POSTDEPLOY_REAL_DIR="$(cd "$POSTDEPLOY_LOCAL_DIR" && pwd -P)"
CHECKOUT_REAL="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
case "$POSTDEPLOY_REAL_DIR/" in "$CHECKOUT_REAL/"*) exit 1 ;; esac
```

In the exact production Railway Console, substitute the new id and create the exact
remote files:

```bash
set -euo pipefail
npm run db:backup -- /data/ai-assistant.sqlite \
  /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite
chmod 600 /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite \
  /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite.sha256 \
  /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite.json
```

In authenticated Railway Files, Save As the database and its `.sha256` and `.json`
sidecars directly as `$POSTDEPLOY_LOCAL_BACKUP.partial`,
`$POSTDEPLOY_LOCAL_BACKUP.sha256.partial`, and
`$POSTDEPLOY_LOCAL_BACKUP.json.partial`. Finalize and verify that transfer exactly once:

```bash
set -euo pipefail
for suffix in "" ".sha256" ".json"; do
  partial_path="${POSTDEPLOY_LOCAL_BACKUP}${suffix}.partial"
  target_path="${POSTDEPLOY_LOCAL_BACKUP}${suffix}"
  test -f "$partial_path"
  test ! -e "$target_path"
  chmod 600 "$partial_path"
  mv "$partial_path" "$target_path"
  test "$(stat -f '%Lp' "$target_path")" = 600
done
(cd "$POSTDEPLOY_LOCAL_DIR" && shasum -a 256 -c "$(basename "$POSTDEPLOY_LOCAL_BACKUP").sha256")
```

Then run this current-key-only restore block; it never executes or sources the earlier
two-key prompt block:

```bash
set -euo pipefail
test -f "$POSTDEPLOY_LOCAL_BACKUP"
test -f "$POSTDEPLOY_LOCAL_BACKUP.sha256"
test -f "$POSTDEPLOY_RELEASE_METADATA"
mkdir -m 700 "$POSTDEPLOY_ISOLATED_DIR"

unset DATA_ENCRYPTION_KEY_PREVIOUS
if [ -z "${DATA_ENCRYPTION_KEY:-}" ]; then
  printf 'DATA_ENCRYPTION_KEY (current production key): ' >&2
  IFS= read -r -s DATA_ENCRYPTION_KEY
  printf '\n' >&2
fi
export DATA_ENCRYPTION_KEY
test -z "${DATA_ENCRYPTION_KEY_PREVIOUS+x}"

POSTDEPLOY_RESTORE_INCIDENT_AT="$(node -p 'new Date().toISOString()')"
POSTDEPLOY_RESTORE_DRILL_STARTED_AT="$POSTDEPLOY_RESTORE_INCIDENT_AT"
RESTORE_INCIDENT_AT="$POSTDEPLOY_RESTORE_INCIDENT_AT" \
RESTORE_DRILL_STARTED_AT="$POSTDEPLOY_RESTORE_DRILL_STARTED_AT" \
RESTORE_DATABASE=YES npm run --silent db:restore -- \
  "$POSTDEPLOY_LOCAL_BACKUP" "$POSTDEPLOY_RESTORED_PATH"
RESTORE_INCIDENT_AT="$POSTDEPLOY_RESTORE_INCIDENT_AT" \
RESTORE_DRILL_STARTED_AT="$POSTDEPLOY_RESTORE_DRILL_STARTED_AT" \
npm run --silent db:verify-restore -- \
  "$POSTDEPLOY_RESTORED_PATH" "$POSTDEPLOY_LOCAL_BACKUP.sha256" \
  "$POSTDEPLOY_RELEASE_METADATA" >"$POSTDEPLOY_RESTORE_EVIDENCE"
node -e '
  const evidence = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const started = Date.parse(evidence.recovery?.drillStartedAt);
  const ready = Date.parse(evidence.recovery?.readinessConfirmedAt);
  const incident = Date.parse(evidence.recovery?.incidentAt);
  const dataAsOf = Date.parse(evidence.recovery?.dataAsOf);
  if (evidence.conclusion !== "passed" ||
      evidence.checks.tokenBackedRead.status !== "passed" ||
      evidence.checks.applicationReadiness.status !== "passed" ||
      evidence.checks.applicationReadiness.endpoint !== "GET /health" ||
      evidence.checks.applicationReadiness.httpStatus !== 200 ||
      evidence.recovery.rtoMs !== ready - started ||
      evidence.recovery.rpoMs !== incident - dataAsOf) process.exit(1);
' "$POSTDEPLOY_RESTORE_EVIDENCE"
chmod 600 "$POSTDEPLOY_RESTORE_EVIDENCE"
shasum -a 256 "$POSTDEPLOY_RESTORE_EVIDENCE"
unset DATA_ENCRYPTION_KEY
```

Retain `POSTDEPLOY_RESTORED_PATH` until the detached live-probe flow below has captured
the installation credential from that restored database. Only this second proof permits
removing the previous production key.

### Detached exact-source live worktree

After the DeepSeek evidence commit, the evidence checkout is no longer the deployed source
candidate. Keep every live script's exact `HEAD == LIVE_RELEASE_SHA` guard: create a clean
detached worktree at `RELEASE_SHA`, run all live scope/AUDIT/member/performance commands
there, and return to the evidence checkout only for import and validation. Start this
immediately after the fresh install so the scope attestation stays within its 15-minute
window:

```bash
set -euo pipefail
EVIDENCE_CHECKOUT="$(git rev-parse --show-toplevel)"
SOURCE_WORKTREE_PARENT="$(mktemp -d /tmp/ai-assistant-live-source.XXXXXX)"
SOURCE_WORKTREE="$SOURCE_WORKTREE_PARENT/source"
git worktree add --detach "$SOURCE_WORKTREE" "$RELEASE_SHA"
test "$(git -C "$SOURCE_WORKTREE" rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git -C "$SOURCE_WORKTREE" status --porcelain --untracked-files=all)"
cleanup_live_source_worktree() {
  exit_status="${1:-$?}"
  trap - EXIT
  set +e
  cleanup_failed=0
  unset LIVE_ADDON_TOKEN LIVE_BACKEND_URL DATA_ENCRYPTION_KEY DATA_ENCRYPTION_KEY_PREVIOUS
  rm -f -- "$SOURCE_WORKTREE/.env" || cleanup_failed=1
  test ! -e "$SOURCE_WORKTREE/.env" || cleanup_failed=1
  cd "$EVIDENCE_CHECKOUT" || cleanup_failed=1
  git worktree remove --force "$SOURCE_WORKTREE" || cleanup_failed=1
  test ! -e "$SOURCE_WORKTREE" || cleanup_failed=1
  rmdir "$SOURCE_WORKTREE_PARENT" || cleanup_failed=1
  test ! -e "$SOURCE_WORKTREE_PARENT" || cleanup_failed=1
  set -e
  if [ "$exit_status" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then return 1; fi
  return "$exit_status"
}
trap 'cleanup_live_source_worktree $?' EXIT
cd "$SOURCE_WORKTREE"

NODE22_BIN_DIR="${NODE22_BIN_DIR:?Set the bin directory of an installed Node 22 distribution}"
NODE22_BIN_DIR="$(cd "$NODE22_BIN_DIR" && pwd -P)"
export PATH="$NODE22_BIN_DIR:$PATH"
test "$(command -v node)" = "$NODE22_BIN_DIR/node"
test "$(command -v npm)" = "$NODE22_BIN_DIR/npm"
test "$(command -v npx)" = "$NODE22_BIN_DIR/npx"
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
npm ci
test -z "$(git status --porcelain --untracked-files=all)"

unset DATA_ENCRYPTION_KEY_PREVIOUS
if [ -z "${DATA_ENCRYPTION_KEY:-}" ]; then
  printf 'DATA_ENCRYPTION_KEY (current production key): ' >&2
  IFS= read -r -s DATA_ENCRYPTION_KEY
  printf '\n' >&2
fi
DATABASE_PATH="$POSTDEPLOY_RESTORED_PATH" \
DATA_ENCRYPTION_KEY="$DATA_ENCRYPTION_KEY" \
LIVE_WORKSPACE_ID="${LIVE_WORKSPACE_ID:?Set the sacrificial production workspace id}" \
  npx tsx scripts/capture-addon-token.ts
test "$(stat -f '%Lp' .env)" = 600
while IFS='=' read -r name value; do
  case "$name" in
    LIVE_ADDON_TOKEN|LIVE_BACKEND_URL) export "$name=$value" ;;
  esac
done <.env
: "${LIVE_ADDON_TOKEN:?capture did not provide LIVE_ADDON_TOKEN}"
: "${LIVE_BACKEND_URL:?capture did not provide LIVE_BACKEND_URL}"
: "${LIVE_WORKSPACE_ID:?Set the sacrificial production workspace id}"
: "${POSTDEPLOY_RESTORED_PATH:?Postdeploy restored database is required}"
: "${POSTDEPLOY_LOCAL_DIR:?Postdeploy evidence directory is required}"

export LIVE_RELEASE_SHA="$RELEASE_SHA"
export LIVE_RELEASE_BUILD_HASH="$(git archive "$RELEASE_SHA" | shasum -a 256 | awk '{print $1}')"
export LIVE_ADDON_BASE_URL="https://ai-assistant-production-c2e6.up.railway.app"
LIVE_EVIDENCE_DIR="$POSTDEPLOY_LOCAL_DIR/live-source-probes"
test ! -e "$LIVE_EVIDENCE_DIR"
mkdir -m 700 "$LIVE_EVIDENCE_DIR"
export SCOPE_PROBE_EVIDENCE_PATH="$LIVE_EVIDENCE_DIR/scope-probe.json"
export DEPLOYED_MANIFEST_EVIDENCE_PATH="$LIVE_EVIDENCE_DIR/deployed-manifest.json"
export ATTESTATION_VERIFICATION_EVIDENCE_PATH="$LIVE_EVIDENCE_DIR/attestation-verification.json"
export HOST_AUTH_EVIDENCE_PATH="$LIVE_EVIDENCE_DIR/host-auth.json"
export MEMBER_DENIAL_EVIDENCE_PATH="$LIVE_EVIDENCE_DIR/member-denial.json"
export PERF_EVIDENCE_DIR="$LIVE_EVIDENCE_DIR/performance"

LIVE_CLOCKIFY=1 LIVE_SCOPE_FRESH_INSTALL=1 npm run --silent probe:scopes
LIVE_CLOCKIFY=1 npx tsx scripts/host-auth-spike.ts
LIVE_CLOCKIFY=1 LIVE_MEMBER_DENIAL=1 LIVE_SACRIFICIAL_WORKSPACE=1 \
  npm run --silent probe:member-denial
LIVE_CLOCKIFY=1 LIVE_PERFORMANCE=1 LIVE_SACRIFICIAL_WORKSPACE=1 \
  npm run perf:private-production:secure

export DEPLOYED_MANIFEST_EVIDENCE="$DEPLOYED_MANIFEST_EVIDENCE_PATH"
export ATTESTATION_VERIFICATION_EVIDENCE="$ATTESTATION_VERIFICATION_EVIDENCE_PATH"
cleanup_live_source_worktree 0
```

Set `NODE22_BIN_DIR` to a real Node 22 distribution before the block (for example,
`/opt/homebrew/opt/node@22/bin`, an active nvm version's `bin`, or a mise installation's
`bin`). Never copy, print, or pass the token on argv. The capture script creates only the ignored,
mode-0600 `.env` in the detached source worktree; its removal is proven before that
worktree is removed. The ignored `node_modules` created by `npm ci` remains inside the
exact worktree and is removed with it by the cleanup trap, including when installation or
a later probe fails. Import and validate the standalone artifacts only from the evidence
checkout.

### Release-only scope and AUDIT-host probes

Both probes run exactly once inside the detached exact-source block above and write only
secret-free JSON to its explicit evidence paths. Do not rerun them from this evidence
checkout: its evidence-only commit is not `LIVE_RELEASE_SHA`, so the exact-HEAD guard must
fail.

Use a production `LIVE_ADDON_TOKEN` for both. The scope probe accepts no local
install-event assertion. It authenticates to the deployed attestation route with the
new token and remotely verifies the server-minted HMAC envelope produced only by a
genuine, verified `/lifecycle/installed` callback no more than 15 minutes earlier.
Same-token callback retries preserve that proof without changing generation or reactivating
an inactive installation.
Replacement tokens cannot mint or reuse it; uninstall removes it. Replacement and
uninstall also retain only a workspace-unlinked, separate-domain fingerprint of the
outgoing token. A separate hashed-workspace issuer-time/state/generation lineage covers
never-before-seen older tokens for 24 hours + 2 minutes + 1 second after the latest accepted event,
preventing restoration after erasure/restart while a strictly newer token remains installable. The probe
also fetches deployed `/version` and `/manifest` and fails unless the release SHA,
build hash, runtime artifact (server plus served UI), source binding, and canonical manifest match the exact
clean checkout before any Clockify request. The all-scopes token proves aggregate
reachability, not per-scope necessity, and the evidence says so explicitly. A separate
valid read-only POST must clear the AUDIT host. Supply secrets outside the command line
and never preserve raw workspaces, tokens, headers, paths, responses, or error details.

## Production browser acceptance and member denial

Run this only in the logged-in Clockify installation after the exact source candidate is
deployed. Start one bounded UTC evidence window (maximum four hours) and keep all raw
browser automation material outside the checkout. The browser capture itself must be a
sanitized step trace; never serialize or preserve a component URL, token, cookie, workspace
or user id, prompt, request/response body, header, nonce, resource id, or customer data.

Within that one window, exercise the actual embedded iframe in Google Chrome and record
only the strict booleans/counts accepted by
`scripts/evidence/live-browser-acceptance.ts`:

- first-run disclosure and saved permissions for all 13 permission groups;
- owner/admin component access, a read receipt, a safe-write receipt, and Undo with
  authoritative absence proof;
- risky preview/cancel with the original effect preserved, then a separate risky
  preview/button-confirm with a receipt and authoritative absence proof;
- chat switching, history restore, full-page reload, and restored operation cards;
- the visible Download PDF action plus authenticated PDF bytes: `.pdf` filename,
  `application/pdf`, `%PDF-` signature, nonzero byte count, authenticated 200, and a
  separate unauthenticated 401;
- at least two `AIASSIST_SMOKE_` resources, exact deletion proof for every created
  resource, zero remaining resources, and zero pending previews.

During the same window, prove denial using a real active member selected from the
role-bearing Clockify workspace list. The probe uses the production installation token to
mint a short-lived member token in memory and calls the deployed component; it accepts
only 403, the fixed admin-only page, and no session cookie. Before any network request or
token exchange, the probe already run inside the detached exact-source block requires the
root public Railway production origin
`https://ai-assistant-production-c2e6.up.railway.app` with no custom port, path, query,
fragment, or user info. Do not rerun it from the evidence checkout.

The browser automation must write one off-worktree JSON result with exactly these
top-level fields: `schemaVersion: 1`,
`kind: "sanitized_browser_automation_trace"`, `startedAt`, `completedAt`,
`deployedVersionObservedAt`, `runtime`, `journeys`, and `cleanup`. The nested values are
the exact observations listed above. Do not hand-author the final evidence artifact.
Capture credential-free `/version`, then use the recorder to hash the exact automation
result bytes and derive all release/source/member fields that the browser is not allowed
to author:

```bash
export SANITIZED_BROWSER_TRACE="$LOCAL_DIR/sanitized-browser-automation.json"
export BROWSER_ACCEPTANCE_EVIDENCE="$LOCAL_DIR/browser-acceptance.json"
export MEMBER_DENIAL_EVIDENCE="$MEMBER_DENIAL_EVIDENCE_PATH"
export DEPLOYED_VERSION_EVIDENCE="$LOCAL_DIR/deployed-version.json"
curl --fail --silent --show-error "$BASE_URL/version" > "$DEPLOYED_VERSION_EVIDENCE"
chmod 600 "$SANITIZED_BROWSER_TRACE" "$MEMBER_DENIAL_EVIDENCE" "$DEPLOYED_VERSION_EVIDENCE"
npm run --silent record:live-browser-evidence -- \
  --trace "$SANITIZED_BROWSER_TRACE" \
  --member-denial "$MEMBER_DENIAL_EVIDENCE" \
  --deployed-version "$DEPLOYED_VERSION_EVIDENCE" \
  --expected-candidate "$RELEASE_SHA" \
  --output "$BROWSER_ACCEPTANCE_EVIDENCE"

export LIVE_BROWSER_EXPECTED_CANDIDATE_SHA="$RELEASE_SHA"
export LIVE_BROWSER_EVIDENCE_COMMIT_SHA="$RELEASE_SHA"
export LIVE_BROWSER_EVIDENCE_PATH="$BROWSER_ACCEPTANCE_EVIDENCE"
export LIVE_BROWSER_TRACE_PATH="$SANITIZED_BROWSER_TRACE"
export LIVE_BROWSER_DEPLOYED_VERSION_PATH="$DEPLOYED_VERSION_EVIDENCE"
export LIVE_BROWSER_VALIDATION_PATH="$LOCAL_DIR/browser-validation.json"
npm run --silent check:live-browser-evidence
```

The recorder refuses any input or output inside the real worktree, resolves existing
output-parent ancestors so a directory symlink cannot redirect its atomic write back into
the checkout, and rejects unsafe targets, input symlinks, and oversize files. It computes
the capture SHA-256 from the raw sanitized automation file,
derives release/build/server/source binding only from deployed `/version`, computes the
canonical member-evidence hash itself, writes mode 0600 atomically, and invokes the same
full validator before emitting output. The exact sanitized trace bytes are imported as
`evidence/operations/production-browser-trace.json`; CI must possess those bytes, reproduce
the final artifact from them, match their recorded SHA-256, repeat the strict secret/schema
validation, and upload them for reviewer inspection. The digest alone is never treated as
proof, and this retention does not pretend to cryptographically attest who drove Chrome.
The validator rejects missing journeys, weak PDF proof, incomplete cleanup, a member proof
outside the browser time window, source/deployment drift, symlinks, oversize files, unknown
fields, and any identifier- or secret-bearing addition.

## Canonical checked-in evidence import

The performance gate, restore drill, scope probe, browser run, and member-denial probe
intentionally write timestamped operator artifacts outside the checkout. Do not copy or
rename them by hand. Capture the
credential-free deployed `/version`, `/manifest`, and public attestation-verification
response beside those artifacts, select the exact files (never a `latest` symlink or
glob), and run the single schema-validating import:

```bash
: "${PRIVATE_PRODUCTION_EVIDENCE:?Set the exact timestamped performance JSON path}"
: "${DEPLOYED_VERSION_EVIDENCE:?Set the captured deployed-version JSON path}"
: "${DEPLOYED_MANIFEST_EVIDENCE:?Set the captured deployed-manifest JSON path}"
: "${ATTESTATION_VERIFICATION_EVIDENCE:?Set the captured verification JSON path}"
: "${BROWSER_ACCEPTANCE_EVIDENCE:?Set the exact browser acceptance JSON path}"
: "${SANITIZED_BROWSER_TRACE:?Set the exact sanitized browser trace JSON path}"
: "${MEMBER_DENIAL_EVIDENCE:?Set the exact member-denial JSON path}"
: "${POSTDEPLOY_RESTORE_EVIDENCE:?Set the current-key-only postdeploy restore JSON path}"

npm run --silent import:release-evidence -- \
  --source-candidate "$RELEASE_SHA" \
  --private-production "$PRIVATE_PRODUCTION_EVIDENCE" \
  --restore "$POSTDEPLOY_RESTORE_EVIDENCE" \
  --scope "$SCOPE_PROBE_EVIDENCE_PATH" \
  --browser "$BROWSER_ACCEPTANCE_EVIDENCE" \
  --browser-trace "$SANITIZED_BROWSER_TRACE" \
  --member-denial "$MEMBER_DENIAL_EVIDENCE" \
  --deployed-version "$DEPLOYED_VERSION_EVIDENCE" \
  --deployed-manifest "$DEPLOYED_MANIFEST_EVIDENCE" \
  --attestation-verification "$ATTESTATION_VERIFICATION_EVIDENCE"
```

Only after that import succeeds, remove the working restored database and prove its
SQLite side files are absent:

```bash
set -euo pipefail
rm -f -- "$POSTDEPLOY_RESTORED_PATH" \
  "$POSTDEPLOY_RESTORED_PATH-wal" "$POSTDEPLOY_RESTORED_PATH-shm"
test ! -e "$POSTDEPLOY_RESTORED_PATH"
test ! -e "$POSTDEPLOY_RESTORED_PATH-wal"
test ! -e "$POSTDEPLOY_RESTORED_PATH-shm"
rmdir "$POSTDEPLOY_ISOLATED_DIR"
```

Then, in the exact production Railway Console, substitute the same drill id and remove
only the three temporary remote files; verify each exact path is absent in Files:

```bash
set -euo pipefail
rm -f /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite \
  /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite.sha256 \
  /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite.json
test ! -e /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite
test ! -e /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite.sha256
test ! -e /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite.json
```

Retain only the mode-0600 encrypted local backup, checksum, metadata, and measured
`POSTDEPLOY_RESTORE_EVIDENCE` in the controlled recovery volume. The import validates and
checks the current-key-only proof into canonical `production-restore.json`.

The command validates all schemas and thresholds, the exact release/build/server/source
binding, manifest and fresh-install envelope, complete scope/AUDIT result, backup RTO/RPO,
complete browser/member/PDF/cleanup proof, and secret-free contract before it opens any destination. It then recursively sorts JSON
object keys and atomically writes only these workflow inputs:

- `evidence/performance/private-production.json`
- `evidence/performance/private-production.md`
- `evidence/operations/production-restore.json`
- `evidence/operations/production-scope-probe.json`
- `evidence/operations/production-browser.json`
- `evidence/operations/production-browser-trace.json`
- `evidence/operations/production-member-denial.json`

Any source mismatch, malformed/tampered artifact, symlink, oversize file, secret-bearing
field, or partial cleanup aborts without updating a canonical file. Review `git diff` and
commit these outputs only as an evidence-only descendant of the source candidate.

## Outcome vocabulary

| State | Operator meaning | Allowed next action |
|---|---|---|
| Queued, not dispatched | No Clockify mutation began | Cancellation may settle definitively; do not describe it as ambiguous |
| Known success | Clockify effect is known and journaled | Return the durable receipt; never downgrade it to retryable failure because later bookkeeping degraded |
| Definitive failure | The planned effect is known not to have occurred | Report failure; retry only through a new authorized operation |
| Partial | At least one known effect occurred and a later step did not complete | Stop later dispatch, preserve every step result, reconcile before further mutation |
| Unknown | A mutation was dispatched but its effect cannot yet be proven | Never retry automatically; use authoritative reconciliation and keep writes blocked when evidence is insufficient |
| Compensated | An eligible compensation is known to have succeeded | Report both the primary and compensation outcomes; do not claim the original effect never happened |

Exact request replay returns the stored durable result. It is not a general exactly-once
guarantee. Semantic duplicate suppression exists only for the documented setup actions.
Invoice write safety is bound to the persisted operation id, exact step journal, and
reconciliation evidence, not payload equality.

## Pause and triage

1. Stop new writes at the narrowest safe boundary. Disable or deactivate the affected
   add-on installation when workspace-local containment is sufficient; drain or stop the
   service only for a service-wide incident.
2. Preserve the deployed commit, Railway deployment id, database path, current health,
   UTC time, and sanitized operation ids before changing code or data.
3. Take an online backup when the database is readable. Never copy the live SQLite,
   `-wal`, and `-shm` files independently.
4. Classify each affected operation using the table above. A client disconnect or model
   cancellation cannot cancel a Clockify mutation after dispatch.
5. For an unknown effect, use only the action's registered complete-list or exact-target
   reconciliation path. A truncated scan, name-only match, or guessed id is insufficient.
6. Keep later steps and compensation blocked until the source step has a durable eligible
   state. Startup recovery reads; it never resumes prepared work or compensates on its own.

## Application rollback

1. Prefer a forward fix when the previous build is not proven compatible with the current
   SQLite schema and durable operation format.
2. If code rollback is safe, open the Railway dashboard for project
   `fb1fa3c6-cc28-40d8-b985-2a7ee7051304`, environment
   `45300bdc-788b-4f63-8749-5a8f7e46b774`, and service
   `2656670e-39a5-40f3-af5c-56dfc637552f`; select the previously verified deployment by
   exact deployment id and commit. Railway CLI 5.27.0 cannot select an arbitrary prior
   deployment by id, so perform and record this rollback in that exact dashboard target.
   Keep the same persistent volume and encryption keys.
3. Do not rotate `SESSION_SECRET` during an unrelated rollback; that invalidates all
   sessions and pending confirmations. Do not rotate encryption keys unless following the
   documented two-key procedure in `DEPLOYMENT.md`.
4. After rollback, verify `/health`, schema compatibility, installation generation,
   token-backed read, and scoped operation history before re-enabling writes.
5. Re-run a synthetic read, preview/cancel, confirm, and cleanup. Record the rollback
   deployment and result.

Rolling back code cannot erase a Clockify effect. The offered Undo control applies only
to eligible recent creations and invokes a separately journaled, best-effort
compensation. It may fail or remain unknown.

## Database restore and disaster recovery

1. Stop or drain the service. Verify the selected backup's checksum, metadata, integrity,
   encryption-key availability, and retention eligibility.
2. Restore to a new file; do not overwrite the current database on the first attempt.
3. Start a one-off instance against the restored file and verify readiness, schema,
   installation state, and a token-backed read.
4. Compare the backup timestamp with every potentially dispatched Clockify operation.
   Database restore does not reverse newer host effects. Mark and reconcile them before
   allowing another write.
5. Switch `DATABASE_PATH` only after the verification succeeds. Preserve the pre-restore
   database and its checksum until reconciliation and incident review close.
6. Record restore-start to the one-off instance's first successful `/health` timestamp as
   RTO, and the backup-to-incident interval as RPO. Static file checks alone are not RTO.

## Provider outage

- Preserve the immediate local status and return a visible provider error.
- Do not convert declaration/provider failure into write authority. Reads that do not
  require a new model decision may remain available; undeclared writes remain denied.
- Do not fail over to another provider for version 1.0.0. DeepSeek remains the configured
  provider unless a separately reviewed release changes that decision.

## Clockify throttle or host outage

- Honor `Retry-After` for queued host work and preserve the per-workspace governor.
- Never automatically retry a write after dispatch.
- Distinguish a pre-dispatch budget, cancellation, role, generation, or installation
  denial from a post-dispatch unknown outcome.
- Keep partial and unknown states visible in receipts, history, audit, and alerts.

## Uninstall or installation revocation

- New and queued writes must fail immediately when the installation is inactive, deleted,
  or on a different generation.
- Uninstall wipes the persisted token and installs a mutation-settlement barrier before
  erasure. Already-dispatched work settles truthfully; queued work does not dispatch.
- After the barrier drains, erase the workspace rows. Startup completes any interrupted
  deletion tombstone before accepting work.
- Exact same-token callback retries are authority-neutral, including while inactive.
  Retired token fingerprints
  contain no workspace id but remain denied after erasure/restart; only a genuinely new
  installation token may establish fresh authority.
- Require finite `exp` on every add-on JWT and bounded `iat` on lifecycle JWTs. Persist
  the generation's issuer watermark and ignore older INSTALLED/STATUS_CHANGED/DELETED
  deliveries. Retain only a separate-domain hashed-workspace lineage for the full
  24-hour + 2-minute + 1-second acceptance envelope after row erasure. Equal whole-second `iat`
  values fail closed as `DELETED > INACTIVE > ACTIVE`; replacement INSTALLED authority
  must be strictly newer.

## Required incident record

For every material incident, record the incident id, redacted affected scope, first and
last UTC timestamps, deployed source-candidate SHA, evidence commit if different,
deployment id, sanitized operation links,
known-success/definitive-failure/partial/unknown counts, containment action, backup and
restore ids if used, reconciliation owner, next update time, final decision, cleanup
result, and evidence location. Never put credentials, prompts, headers, customer payloads,
or raw provider responses in the incident record.

## Re-enable criteria

Re-enable writes only when the service is ready, storage is writable, installation and
role checks pass, every incident operation is settled or deliberately blocked, synthetic
smoke and cleanup pass, and the responsible operator records the decision. A successful
redeploy by itself is not a recovery conclusion.
