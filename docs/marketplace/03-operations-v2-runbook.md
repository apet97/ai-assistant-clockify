# Release, incident, and rollback runbook - v2 engine

> ## Scope: this page owns the v2 release, deploy, backup drill, and the return to v1.
>
> Production serves engine **v2** from `/data/ai-assistant-v2.sqlite`. Every executable
> step below names that database. The retired v1 database and the frozen v1 candidate
> stay untouched as rollback history; the v1 page
> (`docs/marketplace/03-operations-evidence-rollback-package.md`) keeps them, and its own
> scope banner refuses release and deploy use.
>
> **The engine-neutral incident procedures are NOT duplicated here.** They live in the v1
> page and remain its content: "Outcome vocabulary", "Pause and triage", "Database restore
> and disaster recovery", "Provider outage", "Clockify throttle or host outage", "Uninstall
> or installation revocation", "Required incident record", and "Re-enable criteria". Follow
> them there and substitute `/data/ai-assistant-v2.sqlite` wherever a database path is
> required. One copy of a procedure is what keeps the two runbooks from drifting; the v1
> page's banner already instructs that substitution, and rewriting the same eight sections
> here would create a second copy that can silently disagree with it.
>
> **The one exception the v1 banner already names is "Application rollback".** That section
> is v1-bound because it keeps the same volume and encryption keys, which is wrong for a
> v2-to-v1 return. This page owns the v2 replacement; see the signed full v1 return below.
>
> This page does not grant release authority, and application rollback is never reversal of
> a Clockify effect. Record every v2 release result in
> [`evidence/release-candidate-v2.md`](./evidence/release-candidate-v2.md). The historical
> v1 record (`evidence/release-candidate.md`) is immutable rollback history and cannot carry
> a v2 conclusion.
>
> Section names are quoted rather than written as `##` headings on purpose: contract
> assertions locate a section with `indexOf("## <name>")`, and a heading anchor repeated up
> here would silently retarget them to this banner.

The **source candidate** is the clean commit containing all executable v2 code, listing
media, and the passed media-review artifact. It is the commit deployed to Railway. The
reviewed PR/evidence commit may equal that SHA or be a descendant whose entire diff is
checked by the validators as allowlisted non-executable evidence. Never deploy the
descendant merely because it is the PR head.

## The engine selection is asymmetric - export it, never inherit it

Two defaults point in opposite directions, and only one of them is the runtime's:

- **The application defaults to v2.** `src/config.ts` declares
  `ASSISTANT_ENGINE: z.enum(["v1", "v2"]).default("v2")`. An unspecified deployment serves
  the v2 engine.
- **The deploy runbook's expectation defaults to v1.** `DEPLOYMENT.md`'s checked
  transaction sets `EXPECTED_ASSISTANT_ENGINE="${SELECTED_ASSISTANT_ENGINE:-v1}"`, and
  `scripts/deploy-private-production.ts` additionally reads `SELECTED_ASSISTANT_ENGINE` as a
  required variable.

An operator who does not export `SELECTED_ASSISTANT_ENGINE` therefore asserts `v1` against a
process that runs `v2`. Two things break, in this order:

1. `scripts/deploy-private-production.ts` refuses immediately, because
   `SELECTED_ASSISTANT_ENGINE` is required and unset - no Railway call happens. If it were
   instead exported as `v1`, the implicit `RELEASE_SHA` derivation would inherit the frozen
   DeepSeek binding's **v1** candidate and stage v1 source for a v2 release.
2. If a `v1` expectation somehow reached the upload, the post-deploy identity assertion
   compares `/version.modelConfiguration.assistantEngine` against
   `EXPECTED_ASSISTANT_ENGINE` and exits nonzero **after** the deployment is live. A failed
   assertion at that point is a live-traffic incident, not a caught mistake.

**Export both explicitly, before the transaction block, every time:**

```bash
export SELECTED_ASSISTANT_ENGINE=v2
export RELEASE_SHA=<the exact 40-hex v2 candidate>
```

Neither may be inherited. `SELECTED_ASSISTANT_ENGINE` has no correct default for this page,
and `RELEASE_SHA` has no v2 value anywhere in the frozen v1 binding artifact.

## Canonical v2 production release order

1. Freeze the v2 source candidate and record its full commit SHA and archive hash. It must
   already contain the final generated media and the passed media-review artifact.
2. Run every machine, browser, model-evaluation, live-write, performance, lifecycle, and
   recovery gate for that exact SHA. Do not reuse results from an ancestor or an
   uncommitted worktree. The credentialed v2 evaluations, `live:v2-full` plus `live:sweep`,
   and the candidate-bound backup/restore drill are prerequisites, not post-deploy evidence.
3. Create a checksum-verified SQLite backup of `/data/ai-assistant-v2.sqlite` and copy the
   database, SHA-256 sidecar, and metadata sidecar to encrypted off-volume storage.
4. Confirm the backup timestamp and list all nonterminal operation runs. Settle or
   explicitly block any unknown operation before release.
5. Deploy the exact candidate to the single-instance private Railway production service
   through the checked transaction below, with `SELECTED_ASSISTANT_ENGINE=v2`.
6. Verify `/live`, `/health`, `/manifest`, the candidate's own product version, base URL,
   admin-only component, icon, and generated scope contract.
7. Exercise the real Clockify iframe as owner/admin, then verify member denial. Complete
   first run, read, safe write, risky preview/confirm/cancel, undo, history, reload, PDF
   download, and synthetic-resource cleanup.
8. Capture release performance evidence without prompts, credentials, customer data, or raw
   model responses.
9. Push the branch, open the pull request, and require green CI, dependency review,
   gitleaks, CodeQL, and an engineering review with no unresolved P1/P2 finding.
10. Reconfirm that `/version`, the deployment, the media-binding artifact, the browser
    proof, and the recovery proof identify the source-candidate SHA/archive. If the reviewed
    PR head differs, require ancestor and evidence-only-diff validation. Stop before the
    Marketplace **Submit for Review** action.
11. Only then start the observation window defined by
    [`docs/V2_SOAK_SPEC.md`](../V2_SOAK_SPEC.md). Its entry gate consumes this page.

The encrypted backup and isolated restore are a hard precondition, not evidence captured
after deployment. Immediately before upload, export the exact paths created by the
backup/restore section and rerun the executable stop gate. **Run the backup and restore
drill below FIRST:** `LOCAL_BACKUP`, `RELEASE_METADATA`, and `RESTORE_EVIDENCE` are assigned
there, so this block is shown here for its position in the release order and executed after
that section, never before it. **STOP: do not run Railway upload** when this command exits
nonzero:

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

## Exact online backup and isolated restore drill for the v2 database

Mount and unlock an encrypted APFS/FileVault volume at `/Volumes/AIASSIST_RECOVERY`. It is
explicit off-Railway-volume storage and must not be a cloud-sync folder. Keep the production
app online for the SQLite online backup:

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
REMOTE_NAME="ai-assistant-v2-${DRILL_ID}.sqlite"
REMOTE_BACKUP="/data/backups/${REMOTE_NAME}"
LOCAL_DIR="${RECOVERY_VOLUME}/ai-assistant-v2/${RELEASE_SHA}/${DRILL_ID}"
mkdir -p "$LOCAL_DIR"

BACKUP_BOUNDARY_FILE="$LOCAL_DIR/pre-backup-boundary.txt"
npm run --silent db:capture-backup-boundary -- "$BACKUP_BOUNDARY_FILE"

# In the authenticated Railway dashboard Console for the exact production service,
# substitute the resolved DRILL_ID and enter each line separately. The SOURCE is the
# v2 database: with two databases on the volume, backing up the retired v1 file passes
# every checksum, integrity, schema, and freshness check while protecting nothing.
mkdir -p /data/backups
npm run --silent db:backup -- /data/ai-assistant-v2.sqlite \
  /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite
chmod 600 /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite \
  /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite.sha256 \
  /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite.json
```

Railway does not publish an authoritative `ssh.railway.com` host-key set. Do not use
`ssh-keyscan`, `StrictHostKeyChecking=no`, `accept-new`, or a first-seen key for this
database. In the Railway dashboard **Console**, open **Files**, browse `Root` -> `data` ->
`backups`, and Save As each exact file directly to its `.partial` path inside `LOCAL_DIR`.
Never run `env`, `set`, `printenv`, or `sh -lc`. Finalize the browser transfer, verify the
checksum, and bind legacy metadata when required, exactly as the v1 page's transfer and
`db:bind-legacy-backup-metadata` blocks describe - those steps are byte-identical for both
databases because they operate on the transferred files, not on the source path:

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

The v2 database was created by the cutover at schema 13, so its sidecar is format 2 and the
legacy binder is not expected to run. Keep the branch: a database restored from an older
retained backup can still present a format-1 sidecar, and the binder never rewrites one - it
verifies the byte binding and emits a separate format-2 sidecar from the UTC boundary
captured before the remote backup began.

Restore into an isolated private clone and require the verifier's own conclusion. The
restore drill is not a key-rotation drill for a v2 candidate unless a rotation is actually
being performed; when no rotation is in flight, run it with `DATA_ENCRYPTION_KEY_PREVIOUS`
explicitly unset:

```bash
RESTORE_INCIDENT_AT="$(node -p 'new Date().toISOString()')"
RESTORE_DRILL_STARTED_AT="$RESTORE_INCIDENT_AT"
export RESTORE_INCIDENT_AT RESTORE_DRILL_STARTED_AT
ISOLATED_DIR="$LOCAL_DIR/isolated"
RESTORED_PATH="$ISOLATED_DIR/restored.sqlite"
RESTORE_EVIDENCE="$LOCAL_DIR/restore-verification.json"
mkdir -m 700 "$ISOLATED_DIR"
test -f dist/server/server.js

# Both schema bounds are READ from the candidate, never typed as numbers: the v1
# page had to be corrected once because a hardcoded 8 failed a CORRECT restore of
# a current database.
LATEST_SCHEMA_VERSION="$(node -e '
  const source = require("node:fs").readFileSync("src/db/schema.ts", "utf8");
  const found = /LATEST_SCHEMA_VERSION\s*=\s*(\d+)/u.exec(source);
  if (!found) process.exit(1);
  process.stdout.write(found[1]);
')"
MIN_SUPPORTED_RESTORE_SOURCE_SCHEMA_VERSION="$(node -e '
  const source = require("node:fs").readFileSync("src/db/restore-verification.ts", "utf8");
  const found = /MIN_SUPPORTED_RESTORE_SOURCE_SCHEMA_VERSION\s*=\s*(\d+)/u.exec(source);
  if (!found) process.exit(1);
  process.stdout.write(found[1]);
')"
export LATEST_SCHEMA_VERSION MIN_SUPPORTED_RESTORE_SOURCE_SCHEMA_VERSION
printf '%s' "$LATEST_SCHEMA_VERSION" | grep -Eq '^[0-9]+$'
printf '%s' "$MIN_SUPPORTED_RESTORE_SOURCE_SCHEMA_VERSION" | grep -Eq '^[0-9]+$'

unset DATA_ENCRYPTION_KEY_PREVIOUS
if [ -z "${DATA_ENCRYPTION_KEY:-}" ]; then
  printf 'DATA_ENCRYPTION_KEY (current production key): ' >&2
  IFS= read -r -s DATA_ENCRYPTION_KEY
  printf '\n' >&2
fi
export DATA_ENCRYPTION_KEY
test -z "${DATA_ENCRYPTION_KEY_PREVIOUS+x}"

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
  const latest = Number(process.env.LATEST_SCHEMA_VERSION);
  const minSource = Number(process.env.MIN_SUPPORTED_RESTORE_SOURCE_SCHEMA_VERSION);
  if (!Number.isInteger(latest) || !Number.isInteger(minSource)) process.exit(1);
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
      // The full schema triple the canonical importer checks
      // (scripts/evidence/operational-release-evidence.ts). Asserting only the
      // migrated version would let a restore that SILENTLY MIGRATED look
      // identical to one that did not need to.
      !(evidence.checks.schema.sourceUserVersion >= minSource &&
        evidence.checks.schema.sourceUserVersion <= latest) ||
      evidence.checks.schema.userVersion !== latest ||
      evidence.checks.schema.migration !==
        (evidence.checks.schema.sourceUserVersion === latest ? "not_required" : "candidate_private_clone") ||
      evidence.checks.metadata.format !== 2 ||
      !Number.isFinite(drillStarted) || !Number.isFinite(ready) ||
      !Number.isFinite(incident) || !Number.isFinite(dataAsOf) ||
      evidence.recovery.rtoMs !== ready - drillStarted ||
      evidence.recovery.rpoMs !== incident - dataAsOf) process.exit(1);
' "$RESTORE_EVIDENCE"
shasum -a 256 "$RESTORE_EVIDENCE"
unset DATA_ENCRYPTION_KEY
```

Attach the secret-free evidence and hash to the release SHA, then remove only the isolated
restored candidate and the three explicit Railway temporary files. Retain the local backup
set under the approved retention schedule:

```bash
case "$RESTORED_PATH" in "$LOCAL_DIR"/isolated/*) ;; *) exit 64 ;; esac
rm -f -- "$RESTORED_PATH" "$RESTORED_PATH-wal" "$RESTORED_PATH-shm"
rmdir "$ISOLATED_DIR"

case "$REMOTE_BACKUP" in /data/backups/ai-assistant-v2-*.sqlite) ;; *) exit 64 ;; esac
# Run in the authenticated Railway dashboard Console after substituting the same DRILL_ID.
rm -f -- /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite \
  /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite.sha256 \
  /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite.json
test ! -e /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite && \
  test ! -e /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite.sha256 && \
  test ! -e /data/backups/ai-assistant-v2-<DRILL_ID>.sqlite.json
```

The drill never changes production `DATABASE_PATH` and never mutates Clockify. For an actual
restore, drain the service, restore to a new path, run the same verification, and switch
paths only after reconciliation clears newer dispatched host effects.

## Release-candidate checked transaction for a v2 candidate

Only after the encrypted-backup stop gate above passes, bind Railway's public `/version`
response to the exact archive uploaded by `railway up`; neither a deployment timestamp nor a
successful health check is source identity. The transaction pins project
`fb1fa3c6-cc28-40d8-b985-2a7ee7051304`, service `2656670e-39a5-40f3-af5c-56dfc637552f`, and
environment `45300bdc-788b-4f63-8749-5a8f7e46b774` on every variable list/set/rollback and
upload against `https://ai-assistant-production-c2e6.up.railway.app`.

```bash
set -euo pipefail
: "${BASE_URL:?Set BASE_URL to the deployed production HTTPS origin before release}"
BASE_URL="$(npm run --silent release:validate-base-url -- "$BASE_URL")"
export BASE_URL
test -z "$(git status --porcelain --untracked-files=all)"

# Asymmetric by construction: the runtime defaults ASSISTANT_ENGINE to v2 while this
# expectation defaults to v1. It is exported here, never inherited.
export SELECTED_ASSISTANT_ENGINE=v2
EXPECTED_ASSISTANT_ENGINE="${SELECTED_ASSISTANT_ENGINE:-v1}"
export EXPECTED_ASSISTANT_ENGINE
test "$EXPECTED_ASSISTANT_ENGINE" = "v2"

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

# The exact source candidate to stage, hash, and upload. The frozen DeepSeek
# binding names the v1 candidate, so deriving RELEASE_SHA from it is correct
# ONLY for a v1 deploy or a v1 rollback. A v2 release MUST export RELEASE_SHA
# explicitly as the v2 candidate BEFORE this block: deriving it from the binding
# would stage and upload v1 SOURCE while setting ASSISTANT_ENGINE=v2, i.e. v1
# code serving engine v2 against the v2 database - the exact state the
# rollback-key work exists to prevent. Do NOT instead edit the frozen binding: it
# is v1 rollback evidence and is read by the CI candidate gates.
BINDING_CANDIDATE_SHA="$(node -e '
  const binding = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(binding.candidate.testedSha);
' "$DEEPSEEK_BINDING_PATH")"
: "${RELEASE_SHA:?Export the exact v2 candidate SHA; a v2 release may not inherit the binding candidate}"
# Never upload the frozen v1 candidate as a non-v1 engine.
test "$RELEASE_SHA" != "$BINDING_CANDIDATE_SHA"
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
# The product version `/version` must report. Read from the STAGED CANDIDATE,
# never from the working checkout and never as a literal: the uploaded artifact
# is this archive, so a v1 rollback candidate correctly yields its own version
# while the v2 candidate yields its own. A literal here would be wrong for one of
# the two supported engines.
EXPECTED_PRODUCT_VERSION="$(node -e '
  const pkg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) process.exit(1);
  process.stdout.write(pkg.version);
' "$RELEASE_STAGING/package.json")"
export EXPECTED_PRODUCT_VERSION
printf '%s' "$EXPECTED_PRODUCT_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'

export RELEASE_STAGING

# The database this release will serve, plus an explicit claim about whether the
# deploy INTRODUCES that path or ADOPTS one already in service. The claim is
# checked in both directions against Railway's own read-only pre-mutation
# snapshot, so a cutover can neither point at the live database while claiming a
# fresh one nor claim an existing one while introducing a new path.
export SELECTED_DATABASE_PATH="/data/ai-assistant-v2.sqlite"
# Production ALREADY serves this path, so a further v2 release adopts it.
export SELECTED_DATABASE_PATH_DISPOSITION="existing_expected"
# F24 (ADR 001): an ADR-fresh v2 transition - the deployed engine is not yet v2
# - is REFUSED with `existing_expected`: a v2 cutover must introduce a fresh
# `new_unused` path (e.g. /data/ai-assistant-v2.sqlite). The only override is
# an owner-recorded formal ADR-001 supersession, stated explicitly as
#   export SELECTED_ADR001_DECISION="superseded_in_place_migration"
# The transaction also sets the runtime `DATABASE_PATH_DISPOSITION`; on boot a
# `new_unused` claim is PROVEN (src/db/fresh-boundary.ts): a nonempty database
# with no fresh-cutover marker refuses to start before opening the file.
# This rule is engine-state-sensitive, not path-sensitive: the disposition above
# is `existing_expected` because production is ALREADY serving v2 from this exact
# path. Returning to v1 and cutting over again would make the transition
# ADR-fresh once more and require a NEW unused path, not this one.
# `gate:predeploy-backup` matches this against the backup's own recorded
# `metadata.source`. With two databases on the volume, a backup of the WRONG one
# passes every other check - correct checksum, bytes, integrity, schema, and
# freshness - so this is the only thing that ties the evidence to the database
# actually being protected.
export PREDEPLOY_SOURCE_DATABASE_PATH="$SELECTED_DATABASE_PATH"
# The source tree a rollback would return to: the release CURRENTLY serving,
# which is what `/version` reports, never this candidate's staging directory.
# Required BEFORE the upload precisely so a missing rollback source fails while
# the prior release is still up. During a v2 series this necessarily names a v2
# tree; it is the transaction's own UNDO and is NOT the v1 return described
# further below.
SERVING_RELEASE_SHA="$(curl --fail --silent --show-error "$BASE_URL/version" \
  | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0,"utf8")).releaseSha)')"
ROLLBACK_RELEASE_SHA="${ROLLBACK_RELEASE_SHA:-$SERVING_RELEASE_SHA}"
printf '%s' "$ROLLBACK_RELEASE_SHA" | grep -Eq '^[0-9a-f]{40}$'
# An override may not silently disagree with the release being replaced.
test "$ROLLBACK_RELEASE_SHA" = "$SERVING_RELEASE_SHA"
git cat-file -e "$ROLLBACK_RELEASE_SHA^{commit}"
test "$ROLLBACK_RELEASE_SHA" != "$RELEASE_SHA"
ROLLBACK_SOURCE_DIR="$(mktemp -d)"
# Replaces the staging-only trap above so both temp trees are always removed.
trap 'rm -rf -- "$RELEASE_STAGING" "$ROLLBACK_SOURCE_DIR"' EXIT
git archive "$ROLLBACK_RELEASE_SHA" | tar -xf - -C "$ROLLBACK_SOURCE_DIR"
export ROLLBACK_SOURCE_DIR
# This checked transaction runs gate:predeploy-backup before any variable
# mutation, snapshots only allowlisted nonsecret release/model settings, and
# restores their prior presence/value if Railway upload fails.
# STOP: do not run Railway upload if the checked transaction's backup/restore gate fails.
npm run --silent deploy:private-production

VERSION_JSON="$(curl --fail --silent --show-error "$BASE_URL/version")"
node -e '
  const value = JSON.parse(process.argv[1]);
  const expectedModel = JSON.parse(process.env.EXPECTED_MODEL_CONFIGURATION);
  // The frozen binding artifact carries eight keys; the live /version payload
  // carries those eight plus assistantEngine. Sizing the deployed payload
  // against the binding key count alone failed a CORRECT deployment.
  const bindingModelKeys = ["provider", "model", "endpointSha256", "mode", "agentic", "toolSelect", "reasoningEffort", "thinkingMode"];
  const deployedModelKeys = bindingModelKeys.concat(["assistantEngine"]);
  const actualModel = value.modelConfiguration;
  if (value.version !== process.env.EXPECTED_PRODUCT_VERSION || value.releaseSha !== process.env.RELEASE_SHA ||
      value.buildHash !== process.env.RELEASE_BUILD_HASH ||
      value.sourceRelationship !== "source_bound_builder" ||
      value.sourceBindingSha256 !== process.env.RELEASE_SOURCE_BINDING_SHA256 ||
      value.serverArtifactSha256 !== process.env.RELEASE_SERVER_ARTIFACT_SHA256 ||
      !actualModel || Object.keys(actualModel).length !== deployedModelKeys.length ||
      deployedModelKeys.some((key) => !(key in actualModel)) ||
      bindingModelKeys.some((key) => actualModel[key] !== expectedModel[key]) ||
      actualModel.assistantEngine !== process.env.EXPECTED_ASSISTANT_ENGINE) process.exit(1);
' "$VERSION_JSON"
curl --fail --silent --show-error "$BASE_URL/live" >/dev/null
curl --fail --silent --show-error "$BASE_URL/health" >/dev/null
curl --fail --silent --show-error "$BASE_URL/manifest" >/dev/null
```

`scripts/evidence/v2-deployed-engine.ts` (`verifyDeployedV2Engine`) is the machine form of
that same assertion and is what the soak's entry gate consumes. Run it against the captured
`/version` payload and retain its output beside the release record.

If a selected reasoning or thinking setting is `unset`, the corresponding Railway variable
must already be absent. Remove it in the protected Variables UI, repeat the backup gate if
that change deployed anything, and rerun the complete checked transaction. Do not hand-run
`railway variable set` before the gate.

## Application rollback: the signed full v1 return

The v1 page's "Application rollback" section does not apply here. It says to keep the same
persistent volume and encryption keys and to select a previously verified deployment - which
is correct for returning from one v1 build to another, and wrong for leaving v2, because the
v2 database is not a database v1 ever wrote.

**The v1 page's export block is not an executable v1 rollback either.** Its own scope banner
says so. From current production it passes neither disposition:

- `existing_expected` is refused by `scripts/deploy-private-production.ts` because
  `SELECTED_DATABASE_PATH` would name the retired v1 database while the live path is
  `/data/ai-assistant-v2.sqlite`, and the transaction checks the claim against Railway's
  read-only pre-mutation snapshot.
- `new_unused` is refused too. The retained v1 database is nonempty and carries no
  fresh-cutover marker, so `src/db/fresh-boundary.ts` refuses to start before opening the
  file even if the variable check were bypassed - and the same claim is rejected earlier
  because a `new_unused` path may not already be the deployed one.

Both refusals happen before any Railway mutation, which is the intended behavior. It does
mean a literal read-through of that page cannot return production to v1.

**The real path is `planSignedFullV1Rollback` in `scripts/cutover-transaction.ts`.** It is a
pure planning function: it computes and returns a reviewable plan, or throws. Nothing in
that module touches the filesystem, the network, Railway, or Clockify, which is the point -
an incident-time rollback must be decidable without running it. The plan requires all of:

| Plan input | What it must be | Refusal if absent or wrong |
|---|---|---|
| `signature` | The owner's recorded authorization for this branch, nonempty after trimming | `full v1 rollback requires a recorded signature` |
| `restoreSource` | The exact v1 source tree to restore | carried into the plan; never the current staging directory |
| `restoreArtifactHash` | 64 lowercase hex: the v1 release artifact this restore must reproduce | carried into the plan |
| `v1Variables` | The complete recorded v1 values for every `ROLLBACK_KEYS` entry in `scripts/deploy-private-production.ts` (`DATABASE_PATH_DISPOSITION` is introducible and may be absent) | `full v1 rollback is missing a v1 value for: <keys>`, reporting every gap in one pass |
| `v2DatabasePath` | The v2 database this rollback abandons | `full v1 rollback must restore the v1 database` when the recorded `DATABASE_PATH` equals it |

The plan it returns carries `clearsStaleInstallation: true`. That flag is not decorative:
the branch **cannot be planned without it**.

### Why the stale installation row must be cleared

[`docs/adr/003-cross-database-authority.md`](../adr/003-cross-database-authority.md) records
that all installation authority state lives in the application database - the retired-token
denylist, the lifecycle `iat` watermark, and the installation generation. None of it crosses
a database boundary.

A restored v1 database therefore still holds the **pre-outage installation row**.
`saveInstallation` deletes the prior attestation unconditionally and writes a new one only
when the installation row was genuinely absent beforehand, so a reinstall over a restored row
produces an **active installation with no attestation**. The rollback must clear that row
first. `clearStaleInstallationSql(workspaceId)` in `scripts/cutover-transaction.ts` is the
exact statement pair - one delete against `installation_attestations`, one against
`installations`, both scoped to the workspace id - and it rejects an empty id or an id
containing a quote.

Two limits the ADR states explicitly, which this runbook does not overstate:

- Clearing the row closes the **attestation** gap. It does not close the window between
  restoring a database and completing the reinstall, during which the serving database's
  highest known generation is the pre-outage one.
- Every fingerprint retired and every watermark advanced while v2 was serving is discarded
  by the restore, because those rows only ever existed in the v2 file. Release and cutover
  evidence may not claim cross-database replay protection.

Never reactivate an old token to shorten that window. Only a genuinely new installation token
may establish fresh authority.

### Rollback order

1. Record the owner signature, the v1 source tree, the v1 release artifact hash, and the
   complete recorded v1 variable set. Compute the plan first and review it. If
   `planSignedFullV1Rollback` throws, the rollback is not ready - fix the input, do not
   proceed by hand.
2. Confirm the plan's `restoreDatabasePath` is the retained v1 database and is not the v2
   path. The function already refuses the equal case; confirm it against Railway's variable
   snapshot as well, because the plan can only check what it was given.
3. Take a final online backup of `/data/ai-assistant-v2.sqlite` before anything changes. The
   v2 database is the only record of what v2 did, and the return does not delete it.
4. Drain the service. Apply the plan's variable set - including `ASSISTANT_ENGINE`,
   `DATABASE_PATH`, and the three `RELEASE_*` identity variables - and deploy the recorded
   v1 source, requiring the restored artifact to reproduce `restoreArtifactHash`.
5. Clear the stale installation row with `clearStaleInstallationSql` against the restored v1
   database, before the reinstall.
6. Reinstall the add-on for a fresh generation. Do not reuse or reactivate any prior token.
7. Verify `/live`, `/health`, `/manifest`, and `/version` reporting
   `modelConfiguration.assistantEngine` equal to `"v1"` on the v1 rollback tree. A variable
   flipped in the dashboard with no redeploy, or a redeploy still reporting `"v2"`, is not a
   completed rollback.
8. Verify schema compatibility, installation generation, a token-backed read, and scoped
   operation history before re-enabling writes. Then re-run a synthetic read,
   preview/cancel, confirm, and cleanup, and record the rollback deployment and result.

Rolling back code cannot erase a Clockify effect. The offered Undo control applies only to
eligible recent creations and invokes a separately journaled, best-effort compensation. It
may fail or remain unknown.

[`docs/V2_SOAK_SPEC.md`](../V2_SOAK_SPEC.md) commits to completing this return within 24
hours of an immediate-abort criterion firing. That deadline is a commitment against this
section; do not delete or rewrite it while an observation window is open.

## Incident procedures

These are engine-neutral and are **not** repeated here. Follow them in the v1 page, at
[`03-operations-evidence-rollback-package.md`](./03-operations-evidence-rollback-package.md),
substituting `/data/ai-assistant-v2.sqlite` wherever a database path is required.

| Procedure | Where it lives |
|---|---|
| Outcome vocabulary | v1 page, "Outcome vocabulary" |
| Pause and triage | v1 page, "Pause and triage" |
| Database restore and disaster recovery | v1 page, "Database restore and disaster recovery" |
| Provider outage | v1 page, "Provider outage" |
| Clockify throttle or host outage | v1 page, "Clockify throttle or host outage" |
| Uninstall or installation revocation | v1 page, "Uninstall or installation revocation" |
| Required incident record | v1 page, "Required incident record" |
| Re-enable criteria | v1 page, "Re-enable criteria" |
| Application rollback | **This page**, "Application rollback: the signed full v1 return" |

The alert set those procedures react to is `DEPLOYMENT.md` "Required alerts"; the
observation window that watches it is [`docs/V2_SOAK_SPEC.md`](../V2_SOAK_SPEC.md).
