import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RETENTION_PRUNE_FAILURE_THRESHOLD } from "../../src/retention-alerts.js";
import {
  SUSTAINED_HOST_CONSECUTIVE_THRESHOLD,
  SUSTAINED_HOST_WINDOW_MS,
  SUSTAINED_HOST_WINDOW_THRESHOLD,
} from "../../src/clockify/host-throttle-monitor.js";
import { TOKEN_REJECTION_SUSPECT_THRESHOLD } from "../../src/clockify/token-rejection-monitor.js";
import { OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS } from "../../src/operator-health.js";

const read = (path: string): string => readFileSync(resolve(path), "utf8");

describe("release operations contract", () => {
  it("documents every variable the checked deploy transaction requires", () => {
    // T18-A added these four to `deploy-private-production.ts` and updated
    // neither runbook, so following the documented export block literally threw
    // `SELECTED_DATABASE_PATH is required` before any Railway call. Derive the
    // required set from the SCRIPT rather than restating it, so a new
    // `required(environment, ...)` cannot be added without documenting it.
    const script = read("scripts/deploy-private-production.ts");
    const requiredKeys = [...script.matchAll(/required\(environment,\s*"([A-Z0-9_]+)"\)/g)]
      .map((match) => match[1]);
    // The gate runs inside the same transaction, so its inputs are part of the
    // operator's export block too.
    const gateKeys = [...read("scripts/evidence/predeploy-backup-gate.ts")
      .matchAll(/required\("([A-Z0-9_]+)"\)/g)].map((match) => match[1]);
    const allKeys = [...new Set([...requiredKeys, ...gateKeys])];

    expect(allKeys).toContain("SELECTED_DATABASE_PATH");
    expect(allKeys).toContain("PREDEPLOY_SOURCE_DATABASE_PATH");
    expect(allKeys).toContain("ROLLBACK_SOURCE_DIR");

    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      // Word-boundary, not `includes`: a bare substring check lets
      // `SELECTED_DATABASE_PATH_DISPOSITION` satisfy `SELECTED_DATABASE_PATH`,
      // so documenting only the longer name would pass while the shorter one
      // was still missing.
      // Word-boundary, not `includes`: a bare substring check lets
      // `SELECTED_DATABASE_PATH_DISPOSITION` satisfy `SELECTED_DATABASE_PATH`.
      const undocumented = allKeys.filter((key) => !new RegExp(`\\b${key}\\b`).test(runbook));
      expect(undocumented, `${path} undocumented required deploy variables`).toEqual([]);

      // Mentioning a variable is not the same as setting it: the four T18-A
      // additions must be ASSIGNED, or the block still fails when run. (A
      // name-only check passes on `PREDEPLOY_...="$SELECTED_DATABASE_PATH"`
      // even after the assignment it dereferences has been deleted.)
      for (const key of [
        "SELECTED_DATABASE_PATH",
        "SELECTED_DATABASE_PATH_DISPOSITION",
        "PREDEPLOY_SOURCE_DATABASE_PATH",
        "ROLLBACK_SOURCE_DIR",
      ]) {
        expect(
          new RegExp(`(^|\\n)(export\\s+)?${key}=`).test(runbook),
          `${path} assigns ${key}`,
        ).toBe(true);
      }
    }
  });

  it("binds the rollback source to the release actually serving, never to the candidate", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      // A rollback tree equal to the candidate is not a rollback; the script
      // only rejects it being the staging DIRECTORY, which a separate
      // `git archive` of the same sha would slip past.
      expect(runbook, `${path} rollback sha differs from candidate`).toContain(
        'test "$ROLLBACK_RELEASE_SHA" != "$RELEASE_SHA"',
      );
      // ...and equals the release actually serving. Without this the operator
      // could name any ancestor and stage a rollback tree that was never live.
      expect(runbook, `${path} rollback sha matches the running deployment`).toContain(
        'test "$ROLLBACK_RELEASE_SHA" = "$SERVING_RELEASE_SHA"',
      );
      const rollbackExport = runbook.indexOf("export ROLLBACK_SOURCE_DIR");
      const checkedDeploy = runbook.indexOf("npm run --silent deploy:private-production");
      expect(rollbackExport, `${path} rollback source exported`).toBeGreaterThanOrEqual(0);
      expect(checkedDeploy, `${path} rollback source precedes the deploy`).toBeGreaterThan(rollbackExport);
    }
  });

  it("makes encrypted backup and verified restore a hard stop gate before every production Railway upload", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      const canonical = runbook.indexOf("## Canonical production release order");
      const gate = runbook.indexOf("npm run --silent gate:predeploy-backup", canonical);
      const stop = runbook.indexOf("STOP: do not run Railway upload", gate);
      const checkedDeploy = runbook.indexOf("npm run --silent deploy:private-production", canonical);
      expect(canonical, `${path} canonical release order`).toBeGreaterThanOrEqual(0);
      expect(gate, `${path} encrypted-backup gate`).toBeGreaterThan(canonical);
      expect(stop, `${path} hard stop`).toBeGreaterThan(gate);
      expect(checkedDeploy, `${path} checked production deploy`).toBeGreaterThan(stop);
    }

    const transaction = read("scripts/deploy-private-production.ts");
    const gate = transaction.indexOf(
      'commandRunner("npm", ["run", "--silent", "gate:predeploy-backup"])',
    );
    const rollbackBoundary = transaction.indexOf("try {", gate);
    const variableSet = transaction.indexOf('...variableArgs("set")', rollbackBoundary);
    const upload = transaction.indexOf('commandRunner("railway", ["up"', variableSet);
    const failureBoundary = transaction.indexOf("catch (releaseError)", upload);
    const rollback = transaction.indexOf("rollbackVariables(snapshot, Object.keys(desired), commandRunner)", failureBoundary);
    expect(gate, "checked transaction backup gate").toBeGreaterThanOrEqual(0);
    expect(rollbackBoundary, "rollback boundary starts before variable mutation").toBeGreaterThan(gate);
    expect(variableSet, "no-deploy variable mutation").toBeGreaterThan(rollbackBoundary);
    expect(upload, "production upload").toBeGreaterThan(variableSet);
    expect(failureBoundary, "shared mutation/upload failure boundary").toBeGreaterThan(upload);
    expect(rollback, "rollback after either mutation or upload failure").toBeGreaterThan(failureBoundary);
    expect(transaction.slice(variableSet, upload)).toContain('"--skip-deploys"');
  });

  it("asserts the real nine-key deployed version payload and the engine it is actually serving", () => {
    // `/version.modelConfiguration` emits the frozen binding's eight keys PLUS
    // `assistantEngine`. Both runbooks previously sized the deployed payload
    // against the binding key count, so the documented identity assertion
    // exited 1 on a CORRECT deployment and nothing checked the engine at all.
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      // Anchor AFTER the deploy: the runbook now probes `/version` twice — once
      // before the upload to derive the rollback source from the release still
      // serving, and once after to assert the deployed identity. The first
      // occurrence is no longer the identity assertion, and searching from zero
      // would silently grade the wrong block.
      const deployCall = runbook.indexOf("npm run --silent deploy:private-production");
      expect(deployCall, `${path} checked deploy`).toBeGreaterThanOrEqual(0);
      const versionProbe = runbook.indexOf(
        'curl --fail --silent --show-error "$BASE_URL/version"',
        deployCall,
      );
      expect(versionProbe, `${path} deployed version probe follows the deploy`).toBeGreaterThan(deployCall);
      const assertion = runbook.slice(versionProbe, versionProbe + 2_000);

      expect(assertion, `${path} deployed key list`).toContain(
        'const deployedModelKeys = bindingModelKeys.concat(["assistantEngine"]);',
      );
      expect(assertion, `${path} deployed key count`).toContain(
        "Object.keys(actualModel).length !== deployedModelKeys.length",
      );
      expect(assertion, `${path} every deployed key present`).toContain(
        "deployedModelKeys.some((key) => !(key in actualModel))",
      );
      expect(assertion, `${path} binding values compared by value`).toContain(
        "bindingModelKeys.some((key) => actualModel[key] !== expectedModel[key])",
      );
      expect(assertion, `${path} engine identity`).toContain(
        "actualModel.assistantEngine !== process.env.EXPECTED_ASSISTANT_ENGINE",
      );
      // The deployed payload must never be sized against the binding list.
      expect(assertion, `${path} no binding-sized deployed check`).not.toContain(
        "Object.keys(actualModel).length !== bindingModelKeys.length",
      );

      // The intended engine is selected by the operator, never read from the
      // frozen binding artifact, which does not carry the key.
      expect(runbook, `${path} intended engine export`).toContain(
        'EXPECTED_ASSISTANT_ENGINE="${SELECTED_ASSISTANT_ENGINE:-v1}"',
      );
      expect(runbook, `${path} intended engine exported`).toContain("export EXPECTED_ASSISTANT_ENGINE");
      expect(
        runbook.indexOf('EXPECTED_ASSISTANT_ENGINE="${SELECTED_ASSISTANT_ENGINE:-v1}"'),
        `${path} engine selected before the assertion`,
      ).toBeLessThan(versionProbe);
    }
  });

  it("pins deploy commands to exact Railway ids without weakening DeepSeek run isolation", () => {
    const runbook = read("DEPLOYMENT.md");
    const projectId = "fb1fa3c6-cc28-40d8-b985-2a7ee7051304";
    const serviceId = "2656670e-39a5-40f3-af5c-56dfc637552f";
    const environmentId = "45300bdc-788b-4f63-8749-5a8f7e46b774";
    const deepSeekTarget = runbook.slice(
      runbook.indexOf("RAILWAY_TARGET=("),
      runbook.indexOf("RAILWAY_STATUS_JSON="),
    );
    const deployTransaction = runbook.slice(
      runbook.indexOf("For a release-candidate upload"),
      runbook.indexOf("Set `BASE_URL`"),
    );

    for (const id of [projectId, serviceId, environmentId]) {
      expect(deepSeekTarget).toContain(id);
      expect(deployTransaction).toContain(id);
    }
    expect(deepSeekTarget).toContain("--no-local");
    expect(deployTransaction).toContain("does not rely on a linked or local Railway target");
    expect(deployTransaction).toContain("do not accept `--no-local`");
    expect(deployTransaction).not.toMatch(/railway (?:up|variable)[^\n]*--no-local/u);
  });

  it("binds every live launcher and Railway instance guard to the exact production origin", () => {
    const exactOrigin = "https://ai-assistant-production-c2e6.up.railway.app";
    for (const path of [
      "DEPLOYMENT.md",
      "scripts/performance/PRIVATE_PRODUCTION.md",
      "docs/marketplace/03-operations-evidence-rollback-package.md",
    ]) expect(read(path)).toContain(exactOrigin);
    const deployment = read("DEPLOYMENT.md");
    const statusGuard = deployment.slice(
      deployment.indexOf("RAILWAY_STATUS_JSON="),
      deployment.indexOf("unset RAILWAY_STATUS_JSON"),
    );
    expect(statusGuard).toContain("ai-assistant-production-c2e6.up.railway.app");
    expect(statusGuard).toContain("instance?.node?.domains?.serviceDomains");
    expect(statusGuard).toContain("instance?.node?.domains?.customDomains");
  });

  it("documents three standalone scope outputs and a detached exact-source live worktree", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      for (const name of [
        "SCOPE_PROBE_EVIDENCE_PATH",
        "DEPLOYED_MANIFEST_EVIDENCE_PATH",
        "ATTESTATION_VERIFICATION_EVIDENCE_PATH",
      ]) expect(runbook).toContain(`export ${name}=`);
      expect(runbook).toContain('git worktree add --detach "$SOURCE_WORKTREE" "$RELEASE_SHA"');
      expect(runbook).toContain('test "$(git -C "$SOURCE_WORKTREE" rev-parse HEAD)" = "$RELEASE_SHA"');
      expect(runbook).toContain("trap 'cleanup_live_source_worktree $?' EXIT");
      expect(runbook).toContain("NODE22_BIN_DIR=");
      expect(runbook).toContain("Set the bin directory of an installed Node 22 distribution");
      expect(runbook).toContain('test "$(command -v npm)" = "$NODE22_BIN_DIR/npm"');
      expect(runbook).toContain('test "$(command -v npx)" = "$NODE22_BIN_DIR/npx"');
      expect(runbook).toContain("process.versions.node.split");
      expect(runbook).toContain("npm ci");
      expect(runbook).toContain('test -z "$(git status --porcelain --untracked-files=all)"');
      expect(runbook).toContain("scripts/capture-addon-token.ts");
      expect(runbook).toContain('test "$(stat -f \'%Lp\' .env)" = 600');
      expect(runbook).toContain("LIVE_SCOPE_FRESH_INSTALL=1 npm run --silent probe:scopes");
      expect(runbook).toContain("npx tsx scripts/host-auth-spike.ts");
      expect(runbook).toContain("npm run --silent probe:member-denial");
      expect(runbook).toContain("npm run perf:private-production:secure");
      const removeEnv = runbook.indexOf('test ! -e "$SOURCE_WORKTREE/.env"');
      const removeWorktree = runbook.indexOf('git worktree remove --force "$SOURCE_WORKTREE"');
      const install = runbook.indexOf("npm ci", runbook.indexOf("### Detached exact-source live worktree"));
      const capture = runbook.indexOf("scripts/capture-addon-token.ts", install);
      expect(install).toBeGreaterThanOrEqual(0);
      expect(capture).toBeGreaterThan(install);
      expect(removeEnv).toBeGreaterThanOrEqual(0);
      expect(removeWorktree).toBeGreaterThan(removeEnv);
      expect(runbook).toContain("set +e");
      expect(runbook).toContain('test ! -e "$SOURCE_WORKTREE_PARENT"');
      expect(runbook).toContain("ignored `node_modules` created by `npm ci`");
    }
  });

  it("documents a fail-closed thinking-disabled bootstrap that invalidates prior operations evidence", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      const bootstrap = runbook.slice(
        runbook.indexOf("### Conditional thinking-disabled bootstrap"),
        runbook.indexOf("### Release-candidate checked transaction"),
      );
      expect(bootstrap).toContain('modelConfiguration.thinkingMode` is `"disabled"`');
      expect(bootstrap).toMatch(/protected Railway\s+Variables UI/u);
      expect(bootstrap).toContain("one current-source bootstrap deployment");
      expect(bootstrap).toContain("/version.modelConfiguration.thinkingMode");
      expect(bootstrap).toContain("token-backed read");
      expect(bootstrap).toMatch(/invalidate every earlier\s+operational evidence artifact/u);
      expect(bootstrap).toMatch(/entirely fresh backup, restore drill, and\s+predeploy gate/u);
      expect(bootstrap).toMatch(/default\/unset path keeps\s+`LLM_THINKING_MODE` absent/u);
      expect(bootstrap).not.toContain("railway variable set");
    }
  });

  it("provides a separate postdeploy current-key-only second rotation restore", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      const second = runbook.slice(
        runbook.indexOf("### Postdeploy current-key-only second backup and restore"),
        runbook.indexOf("### Release-only scope and AUDIT-host probes"),
      );
      expect(second).toContain("POSTDEPLOY_LOCAL_BACKUP");
      expect(second).toContain("POSTDEPLOY_RESTORED_PATH");
      expect(second).toContain("POSTDEPLOY_RESTORE_EVIDENCE");
      expect(second).toContain(".partial");
      expect(second).toContain("shasum -a 256 -c");
      expect(second).toContain("mkdir -m 700 \"$POSTDEPLOY_LOCAL_DIR\"");
      expect(second).toContain("POSTDEPLOY_REAL_DIR=");
      expect(second).toContain("CHECKOUT_REAL=");
      expect(second).toContain("unset DATA_ENCRYPTION_KEY_PREVIOUS");
      expect(second).toContain("DATA_ENCRYPTION_KEY (current production key)");
      expect(second).not.toContain("DATA_ENCRYPTION_KEY_PREVIOUS (old production key)");
      expect(second).toContain("checks.tokenBackedRead.status");
      expect(second).toContain("checks.applicationReadiness.status");
      expect(second).toContain("recovery.rtoMs");
      expect(second).toContain("recovery.rpoMs");
    }
  });

  it("imports the current-key proof and cleans exact postdeploy working and remote files", () => {
    const runbook = read("docs/marketplace/03-operations-evidence-rollback-package.md");
    expect(runbook).toContain('--restore "$POSTDEPLOY_RESTORE_EVIDENCE"');
    expect(runbook).not.toContain('--restore "$RESTORE_EVIDENCE"');
    expect(runbook).toContain('rm -f -- "$POSTDEPLOY_RESTORED_PATH"');
    expect(runbook).toContain('test ! -e "$POSTDEPLOY_RESTORED_PATH-wal"');
    expect(runbook).toContain("/data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite.sha256");
    expect(runbook).toContain("test ! -e /data/backups/ai-assistant-postdeploy-<POSTDEPLOY_DRILL_ID>.sqlite.sha256");
    expect(runbook).toContain("Retain only the mode-0600 encrypted local backup");
    expect(runbook.match(/LIVE_SCOPE_FRESH_INSTALL=1 npm run --silent probe:scopes/gu)).toHaveLength(1);
    expect(runbook.match(/npx tsx scripts\/host-auth-spike\.ts/gu)).toHaveLength(1);
    expect(runbook.match(/npm run --silent probe:member-denial/gu)).toHaveLength(1);
  });

  it("documents the one executable import into every canonical workflow evidence filename", () => {
    const runbook = read("docs/marketplace/03-operations-evidence-rollback-package.md");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["import:release-evidence"]).toContain("import-release-evidence.ts");
    expect(runbook).toContain("npm run --silent import:release-evidence --");
    for (const path of [
      "evidence/performance/private-production.json",
      "evidence/performance/private-production.md",
      "evidence/operations/production-restore.json",
      "evidence/operations/production-scope-probe.json",
      "evidence/operations/production-browser.json",
      "evidence/operations/production-browser-trace.json",
      "evidence/operations/production-member-denial.json",
    ]) expect(runbook).toContain(path);
    expect(runbook).toContain('--browser "$BROWSER_ACCEPTANCE_EVIDENCE"');
    expect(runbook).toContain('--browser-trace "$SANITIZED_BROWSER_TRACE"');
    expect(runbook).toContain('--member-denial "$MEMBER_DENIAL_EVIDENCE"');
  });

  it("defines a source-bound, secret-free live browser and real member-denial gate", () => {
    const runbook = read("docs/marketplace/03-operations-evidence-rollback-package.md");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["probe:member-denial"]).toContain("live-member-denial-probe.ts");
    expect(pkg.scripts["check:live-browser-evidence"]).toContain("live-browser-acceptance.ts");
    expect(pkg.scripts["record:live-browser-evidence"]).toContain("record-live-browser-acceptance.ts");
    expect(runbook).toContain("npm run --silent record:live-browser-evidence --");
    expect(runbook).toContain("LIVE_MEMBER_DENIAL=1");
    expect(runbook).toContain("first-run disclosure and saved permissions");
    expect(runbook).toContain("authenticated PDF bytes");
    expect(runbook).toContain("never serialize or preserve");
  });

  it("requires baseline and candidate settings on one SHA and five ordered complete cohorts", () => {
    const runbook = read("DEPLOYMENT.md");
    expect(runbook).toContain("same exact clean source-candidate SHA");
    expect(runbook).toContain("five ordered complete cohorts");
    expect(runbook).toContain("--repeat=5");
  });

  it("archives and deploys the binding's tested candidate instead of the evidence checkout HEAD", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      expect(runbook).toContain("binding.candidate.testedSha");
      expect(runbook).toContain('git archive "$RELEASE_SHA"');
      expect(runbook).not.toContain('RELEASE_SHA="$(git rev-parse HEAD)"');
      expect(runbook).not.toMatch(/git archive[^\n]*\bHEAD\b/u);
    }
  });

  it("never lets a non-v1 cutover inherit the frozen v1 candidate as its uploaded source", () => {
    // The frozen DeepSeek binding names the v1 candidate. Deriving RELEASE_SHA from it
    // during a v2 cutover would stage and upload v1 SOURCE while setting
    // ASSISTANT_ENGINE=v2 -- v1 code serving engine v2 against the v2 database. Both
    // runbooks must therefore gate the implicit derivation on the intended engine and
    // refuse a non-v1 deploy whose RELEASE_SHA still equals the binding's candidate.
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      expect(runbook, `${path} captures the binding candidate separately`)
        .toContain('BINDING_CANDIDATE_SHA="$(node -e \'');
      expect(runbook, `${path} only a v1 deploy inherits the binding candidate`)
        .toContain('test "$EXPECTED_ASSISTANT_ENGINE" = "v1"');
      expect(runbook, `${path} a non-v1 deploy may not upload the v1 candidate`)
        .toContain('test "$RELEASE_SHA" != "$BINDING_CANDIDATE_SHA"');

      // The engine check must precede the archive that stages the upload.
      const guard = runbook.indexOf('test "$RELEASE_SHA" != "$BINDING_CANDIDATE_SHA"');
      const archive = runbook.indexOf('git archive "$RELEASE_SHA" | tar -xf -');
      expect(guard, `${path} guard present`).toBeGreaterThanOrEqual(0);
      expect(archive, `${path} staging archive present`).toBeGreaterThanOrEqual(0);
      expect(guard, `${path} guard precedes staging`).toBeLessThan(archive);
    }
  });

  it("binds legacy v7 metadata before restore and uses only the resulting format-2 sidecar", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      const boundary = runbook.indexOf("npm run --silent db:capture-backup-boundary --");
      const remoteBackup = runbook.indexOf("npm run --silent db:backup -- /data/ai-assistant.sqlite");
      expect(boundary, `${path} pre-backup RPO boundary`).toBeGreaterThanOrEqual(0);
      expect(remoteBackup, `${path} remote backup`).toBeGreaterThan(boundary);
      expect(runbook).toContain("npm run --silent db:bind-legacy-backup-metadata --");
      expect(runbook).toContain('"$BACKUP_BOUNDARY_FILE" "$RELEASE_METADATA"');
      expect(runbook).toContain('export PREDEPLOY_BACKUP_METADATA_PATH="$RELEASE_METADATA"');
      expect(runbook).toMatch(
        /npm run --silent db:verify-restore -- \\\n\s+"\$RESTORED_PATH" "\$LOCAL_BACKUP\.sha256" "\$RELEASE_METADATA"/u,
      );
      expect(runbook).not.toMatch(
        /npm run --silent db:verify-restore -- \\\n\s+"\$RESTORED_PATH" "\$LOCAL_BACKUP\.sha256" "\$LOCAL_BACKUP\.json"/u,
      );
    }
  });

  it("uses the authenticated Railway Console fallback without trusting an unpublished SSH host key", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      expect(runbook).toContain("Railway CLI 5.27.0");
      expect(runbook).toContain("Railway dashboard **Console**");
      expect(runbook).toContain("StrictHostKeyChecking=no");
      expect(runbook).toContain("ssh-keyscan");
      expect(runbook).toContain("railway service files");
      expect(runbook).toMatch(
        /railway service files -p fb1fa3c6-cc28-40d8-b985-2a7ee7051304\s+\\?\s*-s 2656670e-39a5-40f3-af5c-56dfc637552f\s+\\?\s*-e 45300bdc-788b-4f63-8749-5a8f7e46b774/u,
      );
      expect(runbook).not.toMatch(/railway service files[^\n]*-s ai-assistant/u);
      expect(runbook).not.toMatch(/railway service files[^\n]*-e production/u);
      expect(runbook).toContain('download "${REMOTE_BACKUP}${suffix}" "$partial_path"');
      expect(runbook).toContain("rm -f -- /data/backups/ai-assistant-<DRILL_ID>.sqlite");
      expect(runbook).not.toContain('delete "${REMOTE_BACKUP}${suffix}" --yes');
      expect(runbook).toContain('railway ssh keys remove "$RELEASE_KEY_FINGERPRINT"');
      expect(runbook).toContain('ssh-add -d "$RELEASE_KEY"');
      expect(runbook).not.toMatch(/railway ssh[^\n]*sh -lc/u);
      expect(runbook).not.toContain("| /usr/bin/base64 -D");
    }
  });

  it("binds application rollback to the exact dashboard target and prior deployment", () => {
    const runbook = read("docs/marketplace/03-operations-evidence-rollback-package.md");
    const rollback = runbook.slice(
      runbook.indexOf("## Application rollback"),
      runbook.indexOf("## Database restore and disaster recovery"),
    );
    for (const id of [
      "fb1fa3c6-cc28-40d8-b985-2a7ee7051304",
      "2656670e-39a5-40f3-af5c-56dfc637552f",
      "45300bdc-788b-4f63-8749-5a8f7e46b774",
    ]) expect(rollback).toContain(id);
    expect(rollback).toContain("exact deployment id and commit");
    expect(rollback).toContain("Railway CLI 5.27.0 cannot select an arbitrary prior");
    expect(rollback).toContain("exact dashboard target");
  });

  it("requires both encryption keys when the release drill proves a production key rotation", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      expect(runbook).toContain("The 1.0.0 drill is a data-encryption-key rotation drill");
      expect(runbook).toContain("DATA_ENCRYPTION_KEY_PREVIOUS (old production key)");
      expect(runbook).toContain("export DATA_ENCRYPTION_KEY DATA_ENCRYPTION_KEY_PREVIOUS");
      expect(runbook).toMatch(/`DATA_ENCRYPTION_KEY_PREVIOUS` explicitly\s+unset/u);
      expect(runbook).toContain("Only after that second restore");
      expect(runbook).toContain(
        "value.serverArtifactSha256 !== process.env.RELEASE_SERVER_ARTIFACT_SHA256",
      );
    }
  });

  it("keeps restore-verifier stdout machine-readable while rebuilding the exact artifact", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:verify-restore"]).toContain("npm run build 1>&2");
    expect(pkg.scripts["db:verify-restore"]).toContain("tsx scripts/verify-restored-db.ts");
  });
});

// Deliberately NOT folded into the two-file loops above. Those assert
// v1-by-design facts — the `"v1"` engine equality at the cutover guard, the
// exact v1 backup command, the 1.0.0 key-rotation drill — which a v2 runbook
// must fail. Joining them would force a v2 fork to impersonate v1.
describe("v1 rollback runbook scope", () => {
  const V1_RUNBOOK = "docs/marketplace/03-operations-evidence-rollback-package.md";

  it("refuses release and deploy use unambiguously", () => {
    // Production serves engine v2 from `/data/ai-assistant-v2.sqlite`, but every
    // executable release step on this page names the retired v1 database. The
    // title says only "version 1.0.0" and no procedure carries an engine
    // qualifier, so without an explicit refusal an operator reads a generic
    // "release, incident, reconciliation, and rollback runbook" and follows it
    // against v2 — completing a full backup and restore drill of a database
    // nothing is serving before the deploy transaction refuses the upload.
    const runbook = read(V1_RUNBOOK);
    expect(runbook).toContain("## Scope: do not release or deploy from this page.");
    expect(runbook).toContain("docs/marketplace/03-operations-v2-runbook.md");
    // Ahead of the first procedure, not buried below it.
    expect(runbook.indexOf("Scope: do not release or deploy"))
      .toBeLessThan(runbook.indexOf("## Canonical production release order"));
  });

  it("keeps the incident sections applicable to both engines", () => {
    // The refusal is scoped to release/deploy/backup ON PURPOSE. Triage and
    // disaster recovery exist NOWHERE else in the repository, so a blanket "does
    // not apply to v2" would leave a v2 operator with no incident procedure at
    // all — and the v2 runbook it redirects to does not exist until D9 forks it.
    const runbook = read(V1_RUNBOOK);
    const banner = runbook.slice(0, runbook.indexOf("## Canonical production release order"));
    // The banner is a wrapped blockquote, so a section name can straddle a
    // `>`-prefixed line break. Match against the unwrapped text.
    const bannerText = banner.replace(/^>\s?/gmu, "").replace(/\s+/gu, " ");
    expect(bannerText).toContain("The incident sections below still apply to both engines");
    for (const section of [
      "Outcome vocabulary",
      "Pause and triage",
      "Database restore and disaster recovery",
      "Provider outage",
      "Clockify throttle or host outage",
      "Uninstall or installation revocation",
      "Required incident record",
      "Re-enable criteria",
    ]) {
      // Named in the banner AND still present as a real section below it.
      expect(bannerText, `${section} must stay named in the banner`).toContain(`"${section}"`);
      expect(runbook, `${section} must stay a real section`).toContain(`\n## ${section}\n`);
    }
    // "Application rollback" is the stated exception: it keeps the same volume
    // and encryption keys, which is wrong for a v2-to-v1 return.
    expect(bannerText).toContain('"Application rollback" is the exception');
    // The banner must never mint a `## <name>` anchor: several contract
    // assertions locate a section with indexOf("## <name>"), and a duplicate
    // above the real heading silently retargets them to this banner. That is
    // not hypothetical — it inverted the Application-rollback slice at :416.
    expect(banner).not.toMatch(/^>?\s*#{2,}\s+(?!Scope: )/mu);
  });

  it("keeps the v1 database path in every executable step", () => {
    // One database path per document: this page keeps the v1 path in its
    // executable steps and the v2 runbook owns the v2 path. Correcting the same
    // path in two documents is how the two runbooks drift apart.
    const runbook = read(V1_RUNBOOK);
    // Anchored on the argument and assignment forms rather than the bare path,
    // because the scope banner NAMES both databases in prose. An unanchored
    // count would move whenever that prose is reworded.
    expect(runbook.match(/-- \/data\/ai-assistant\.sqlite/gu)).toHaveLength(2);
    expect(runbook).toContain('export SELECTED_DATABASE_PATH="/data/ai-assistant.sqlite"');
    // The fourth site. It must keep DERIVING, never carry a literal: the real
    // cutover decoupled these two (`docs/V2_CUTOVER_RECORD.md`), so a future
    // editor has a live precedent for hardcoding it, and the predeploy gate
    // compares the backup's own recorded source against exactly this value.
    expect(runbook).toContain('export PREDEPLOY_SOURCE_DATABASE_PATH="$SELECTED_DATABASE_PATH"');
    expect(runbook).not.toMatch(/PREDEPLOY_SOURCE_DATABASE_PATH="\/data\//u);
    // The v2 path may be NAMED by the scope banner; it must never be EXECUTED here.
    expect(runbook).not.toMatch(/-- \/data\/ai-assistant-v2\.sqlite/u);
    expect(runbook).not.toContain('SELECTED_DATABASE_PATH="/data/ai-assistant-v2.sqlite"');
  });
});

/**
 * D9. A SIBLING of the two-file loops at the top of this file, deliberately not a
 * third entry in them. Those loops assert v1-by-design facts — the `"v1"` engine
 * equality at the cutover guard, the exact v1 backup command, the 1.0.0
 * key-rotation drill — which a v2 runbook must FAIL. Adding this page to them
 * would force the v2 fork to impersonate v1, which is the drift the fork exists
 * to end.
 */
describe("v2 operations runbook scope", () => {
  const V2_RUNBOOK = "docs/marketplace/03-operations-v2-runbook.md";
  const V1_RUNBOOK = "docs/marketplace/03-operations-evidence-rollback-package.md";

  it("exists at the exact path the v1 banner and the soak spec redirect to", () => {
    // D1 could not assert this: the file did not exist, so the v1 banner pointed
    // at a path nothing checked and `docs/V2_SOAK_SPEC.md` called its absence a
    // blocking prerequisite. A typo'd filename would leave both documents naming
    // a page no operator can open.
    expect(existsSync(resolve(V2_RUNBOOK))).toBe(true);
    expect(read(V1_RUNBOOK), "the v1 banner redirects here").toContain(V2_RUNBOOK);
    expect(read("docs/V2_SOAK_SPEC.md"), "the soak spec points here").toContain(V2_RUNBOOK);
  });

  it("keeps the v2 database path in every executable step", () => {
    // Mirror of the v1 page's pin, in the other direction. One database path per
    // document: this page EXECUTES the v2 path and the v1 page executes the v1
    // one. Anchored on the argument and assignment forms rather than the bare
    // path, because the prose here legitimately NAMES the retired v1 database
    // when it explains why the v1 export block cannot execute.
    const runbook = read(V2_RUNBOOK);
    expect(runbook).toMatch(/-- \/data\/ai-assistant-v2\.sqlite/u);
    expect(runbook).toContain('export SELECTED_DATABASE_PATH="/data/ai-assistant-v2.sqlite"');
    // Still DERIVED, never a literal: `gate:predeploy-backup` compares the
    // backup's own recorded `metadata.source` against exactly this value, and
    // the real cutover decoupled the two paths, so a future editor has a live
    // precedent for hardcoding it.
    expect(runbook).toContain('export PREDEPLOY_SOURCE_DATABASE_PATH="$SELECTED_DATABASE_PATH"');
    expect(runbook).not.toMatch(/PREDEPLOY_SOURCE_DATABASE_PATH="\/data\//u);
    // The v1 path may be NAMED in prose; it must never be EXECUTED here.
    expect(runbook).not.toMatch(/-- \/data\/ai-assistant\.sqlite/u);
    expect(runbook).not.toContain('SELECTED_DATABASE_PATH="/data/ai-assistant.sqlite"');
  });

  it("states the engine-default asymmetry against both of its real anchors", () => {
    const runbook = read(V2_RUNBOOK);
    // The runtime default is v2...
    expect(read("src/config.ts")).toContain('ASSISTANT_ENGINE: z.enum(["v1", "v2"]).default("v2")');
    expect(runbook).toContain('ASSISTANT_ENGINE: z.enum(["v1", "v2"]).default("v2")');
    // ...while the deploy transaction's EXPECTATION defaults the other way, so an
    // operator who exports nothing asserts v1 against a process running v2.
    expect(read("DEPLOYMENT.md")).toContain('EXPECTED_ASSISTANT_ENGINE="${SELECTED_ASSISTANT_ENGINE:-v1}"');
    expect(runbook).toContain('EXPECTED_ASSISTANT_ENGINE="${SELECTED_ASSISTANT_ENGINE:-v1}"');
    // The reconciliation is an explicit export plus a check, before the deploy.
    expect(runbook).toContain("export SELECTED_ASSISTANT_ENGINE=v2");
    expect(runbook).toContain('test "$EXPECTED_ASSISTANT_ENGINE" = "v2"');
    const exported = runbook.indexOf("export SELECTED_ASSISTANT_ENGINE=v2");
    const deploy = runbook.indexOf("npm run --silent deploy:private-production");
    expect(exported, "engine exported").toBeGreaterThanOrEqual(0);
    expect(deploy, "engine exported before the deploy").toBeGreaterThan(exported);
    // ...and the script really does require it, so the refusal described is real.
    expect(read("scripts/deploy-private-production.ts"))
      .toContain('required(environment, "SELECTED_ASSISTANT_ENGINE")');
  });

  it("carries the F24/ADR-001 fresh-cutover rule that no marketplace page had", () => {
    const runbook = read(V2_RUNBOOK);
    expect(runbook).toContain("F24 (ADR 001)");
    expect(runbook).toContain('export SELECTED_ADR001_DECISION="superseded_in_place_migration"');
    expect(runbook).toContain("src/db/fresh-boundary.ts");
    expect(runbook).toContain("new_unused");
    // The rule is enforced in code, not merely described; pin the enforcement so
    // the paragraph cannot outlive it.
    const deployScript = read("scripts/deploy-private-production.ts");
    expect(deployScript).toContain(
      'environment.SELECTED_ADR001_DECISION !== "superseded_in_place_migration"',
    );
    expect(deployScript).toContain(
      "An ADR-fresh v2 transition requires SELECTED_DATABASE_PATH_DISPOSITION=new_unused. ",
    );
    expect(existsSync(resolve("src/db/fresh-boundary.ts"))).toBe(true);
  });

  it("derives the expected product version from the staged candidate", () => {
    // D12 added `EXPECTED_PRODUCT_VERSION` as a required export. A page that
    // mentions it without ASSIGNING it still fails a literal read-through, and a
    // literal semver would be wrong for one of the two supported engines.
    const runbook = read(V2_RUNBOOK);
    expect(runbook).toMatch(/(^|\n)EXPECTED_PRODUCT_VERSION="/u);
    expect(runbook).toContain("export EXPECTED_PRODUCT_VERSION");
    expect(runbook).toContain('"$RELEASE_STAGING/package.json"');
    expect(runbook).toContain("value.version !== process.env.EXPECTED_PRODUCT_VERSION");
    expect(runbook.indexOf("export EXPECTED_PRODUCT_VERSION"))
      .toBeLessThan(runbook.indexOf("value.version !== process.env.EXPECTED_PRODUCT_VERSION"));
  });

  it("documents the real v1 return instead of the export block that cannot execute", () => {
    const runbook = read(V2_RUNBOOK);
    expect(runbook).toContain("## Application rollback: the signed full v1 return");
    expect(runbook).toContain("planSignedFullV1Rollback");
    expect(runbook).toContain("clearStaleInstallationSql");
    expect(runbook).toContain("clearsStaleInstallation: true");
    // Both refusals the v1 export block hits from current production.
    expect(runbook).toContain("existing_expected");
    expect(runbook).toContain("docs/adr/003-cross-database-authority.md");
    // Every name the runbook sends an operator to must still exist.
    const cutover = read("scripts/cutover-transaction.ts");
    expect(cutover).toContain("export function planSignedFullV1Rollback(");
    expect(cutover).toContain("export function clearStaleInstallationSql(");
    expect(cutover).toContain("clearsStaleInstallation: true");
    expect(existsSync(resolve("docs/adr/003-cross-database-authority.md"))).toBe(true);
    // ...and it may not promise more than ADR 003 allows.
    expect(runbook).toContain("may not claim cross-database replay protection");
  });

  it("references the engine-neutral incident sections instead of forking them", () => {
    // The D9 decision on the eight engine-neutral procedures: REFERENCE, do not
    // move. D1 already made the v1 page their home and pinned them there as real
    // `## ` sections, and its banner already says to substitute the live database
    // path. A second copy here could silently disagree with that one.
    const runbook = read(V2_RUNBOOK);
    const v1 = read(V1_RUNBOOK);
    for (const section of [
      "Outcome vocabulary",
      "Pause and triage",
      "Database restore and disaster recovery",
      "Provider outage",
      "Clockify throttle or host outage",
      "Uninstall or installation revocation",
      "Required incident record",
      "Re-enable criteria",
    ]) {
      // Named here, so no procedure becomes unreachable from the v2 runbook...
      expect(runbook, `${section} must be named here`).toContain(section);
      // ...still a real section there...
      expect(v1, `${section} must stay a real section on the v1 page`).toContain(`\n## ${section}\n`);
      // ...and NOT re-forked here.
      expect(runbook, `${section} must not be forked here`).not.toContain(`\n## ${section}\n`);
    }
    expect(runbook, "the v2 runbook links the v1 page").toContain("./03-operations-evidence-rollback-package.md");
    // "Application rollback" is the v1 banner's stated exception, so this page
    // owns its own and the v1 one is NOT referenced as applicable.
    expect(v1).toContain("\n## Application rollback\n");
    expect(runbook).toContain('**This page**, "Application rollback: the signed full v1 return"');
  });

  it("qualifies both references that used to name only the v1 page", () => {
    for (const [path, v2Link] of [
      ["MARKETPLACE_READINESS.md", "./docs/marketplace/03-operations-v2-runbook.md"],
      ["docs/marketplace/02-reviewer-package.md", "./03-operations-v2-runbook.md"],
    ] as const) {
      const doc = read(path);
      expect(doc, `${path} links the v2 runbook`).toContain(v2Link);
      // The v1 link survives, on exactly one line, and that line says which
      // engine it is for. An unqualified "incident and recovery procedure" is
      // how a reader ends up following the retired release order against the
      // live database.
      const v1Basename = "03-operations-evidence-rollback-package.md";
      const lines = doc.split("\n").filter((line) => line.includes("](./") && line.includes(v1Basename));
      expect(lines, `${path} links the v1 page exactly once`).toHaveLength(1);
      expect(lines[0]!, `${path} qualifies the v1 link`).toMatch(/\bv1\b/u);
    }
  });
});

/**
 * D6: four documents REQUIRED a production soak and none DEFINED one, so "soak"
 * was an unfalsifiable gate — anyone could declare it passed. `docs/V2_SOAK_SPEC.md`
 * defines it. These assertions exist so the definition cannot rot away from the
 * two things it is derived from:
 *
 *  - its watch list is not prose. Every match string must stay SET-EQUAL to
 *    `DEPLOYMENT.md`'s "Required alerts" table, and every threshold it quotes
 *    must equal the exported constant, so renaming an event or retuning a
 *    monitor fails here as well as in `required-alerts-contract.test.ts`; and
 *  - the owner-decided window and rollback deadline are double-entry literals
 *    carried by the four requiring documents, the same coupling convention
 *    `scripts/evidence/cold-verify-evidence.ts` uses for the suite floor.
 *
 * Every parse below throws or asserts a nonzero count first: a silently empty
 * table parse or a doc that lost its soak sentence must FAIL, never pass.
 */
describe("v2 soak specification", () => {
  const SPEC_PATH = "docs/V2_SOAK_SPEC.md";
  const SPEC = read(SPEC_PATH);
  const DEPLOY = read("DEPLOYMENT.md");

  /** The four documents that require a soak and must point at the one that defines it. */
  const REQUIRING_DOCS = [
    "CLAUDE.md",
    "MARKETPLACE_READINESS.md",
    "README.md",
    "docs/V2_CLOSURE_ACCEPTANCE.md",
  ];

  const section = (source: string, heading: string, label: string): string => {
    const found = new RegExp(`\\n${heading}\\n([\\s\\S]*?)\\n## `, "u").exec(source);
    if (!found) throw new Error(`${label}: no section "${heading}"`);
    return found[1]!;
  };

  const backticked = (cell: string): string[] =>
    [...cell.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);

  /** Row number -> the backticked strings in the THIRD cell of a 5-column table. */
  const matchStringsByRow = (body: string): Map<number, string[]> => {
    const rows = new Map<number, string[]>();
    for (const line of body.split("\n")) {
      const cells = /^\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|$/u.exec(line);
      if (!cells) continue;
      const number = Number(cells[1]!.trim());
      if (!Number.isInteger(number)) continue; // header / separator row
      rows.set(number, backticked(cells[3]!));
    }
    return rows;
  };

  /**
   * Same shape as `required-alerts-contract.test.ts`: absent means throw, never
   * 0. Unlike that helper this collects EVERY occurrence, because the spec
   * states each threshold twice — once in the watch-list cell and once in the
   * pinned list. A first-match-only read let a drift in the second site hide
   * behind the first, which is exactly the vacuity this test exists to avoid.
   */
  const documented = (name: string): number => {
    const found = [...SPEC.matchAll(new RegExp(`\`${name}\`\\s*=\\s*([\\d_]+)`, "gu"))].map(
      (match) => Number(match[1]!.replace(/_/gu, "")),
    );
    if (found.length === 0) throw new Error(`${SPEC_PATH} never states \`${name}\` = <number>`);
    for (const value of found) {
      if (value === found[0]) continue;
      throw new Error(`${SPEC_PATH} states conflicting \`${name}\` values: ${found.join(", ")}`);
    }
    return found[0]!;
  };

  /**
   * Collect EVERY occurrence of a quantity across several permitted phrasings
   * and require them all to agree.
   *
   * An earlier version used `.exec()` for the rollback deadline and swept only
   * the six alert constants, so mutating the deadline at its second or third
   * mention left the suite green — the exact first-match vacuity this file's
   * own comments warn about. Nothing here may use `.exec()` for a quantity.
   */
  const sweep = (patterns: readonly RegExp[], label: string): number => {
    const flat = SPEC.replace(/\s+/gu, " ");
    const values = patterns.flatMap((pattern) =>
      [...flat.matchAll(pattern)].map((match) => Number(match[1]!)),
    );
    if (values.length === 0) throw new Error(`${SPEC_PATH} never states ${label}`);
    for (const value of values) {
      if (value === values[0]) continue;
      throw new Error(`${SPEC_PATH} states conflicting ${label}: ${values.join(", ")}`);
    }
    return values[0]!;
  };

  /**
   * A bare `SPEC.slice(indexOf(a), indexOf(b))` returns a long, non-empty string
   * when either anchor is MISSING (-1 slices from the end / to the end), so a
   * renamed heading silently keeps every `toContain` below passing against the
   * wrong region. Both anchors must be found.
   */
  const slice = (from: string, to: string): string => {
    const start = SPEC.indexOf(from);
    const end = SPEC.indexOf(to);
    expect(start, `${SPEC_PATH} has the heading "${from}"`).toBeGreaterThanOrEqual(0);
    expect(end, `${SPEC_PATH} has the heading "${to}"`).toBeGreaterThan(start);
    return SPEC.slice(start, end);
  };

  /**
   * The spec's §10 states these as CLOSED rules: every hour/day quantity is one
   * of the listed forms. `CONSTRAINED_*` must all equal the owner's value;
   * `FREE_*` are the deliberately unconstrained rejected alternatives (and, for
   * days, a system retention period that is not this document's number). The
   * completeness check strips both sets and requires nothing to remain, so a
   * NEW phrasing cannot slip past the sweep by not matching any pattern.
   */
  const CONSTRAINED_HOURS = [/within (\d+) hours/giu, /(\d+)-hour deadline/giu] as const;
  const FREE_HOURS = [/(\d+)-hour option/giu] as const;
  const CONSTRAINED_DAYS = [
    /(\d+) consecutive days/giu,
    /(\d+) days/giu,
    /(\d+)-day (?:soak|clock|window)/giu,
  ] as const;
  const FREE_DAYS = [/(\d+)-day option/giu, /(\d+)-day retention/giu] as const;

  const SOAK_DAYS = sweep(CONSTRAINED_DAYS, "the soak window in days");
  const ROLLBACK_HOURS = sweep(CONSTRAINED_HOURS, "the rollback deadline in hours");

  const markdownFiles = (): string[] => {
    const skip = /(^|\/)(node_modules|dist|coverage|\.git|test-results|playwright-report)(\/|$)/u;
    return readdirSync(".", { recursive: true, encoding: "utf8" })
      .map((entry) => entry.replace(/\\/gu, "/"))
      .filter((entry) => entry.endsWith(".md") && !skip.test(entry));
  };

  it("records the owner's decided window and rollback deadline, consistently throughout", () => {
    // The two owner decisions. `sweep` already required every occurrence of each
    // to agree, so these fix the agreed value.
    expect(SOAK_DAYS).toBe(7);
    expect(ROLLBACK_HOURS).toBe(24);

    // Both quantities must be restated, or "all occurrences agree" is a claim
    // about one occurrence.
    const count = (patterns: readonly RegExp[]): number =>
      patterns.reduce((total, p) => total + [...SPEC.replace(/\s+/gu, " ").matchAll(p)].length, 0);
    expect(count(CONSTRAINED_HOURS), "the deadline is restated").toBeGreaterThanOrEqual(4);
    expect(count(CONSTRAINED_DAYS), "the window is restated").toBeGreaterThanOrEqual(4);

    // `7 × 24 h` is the form the pass/fail condition and the artifact both use.
    const arithmetic = [...SPEC.matchAll(/(\d+) × 24 h/gu)];
    expect(arithmetic.length, "the spec states the window arithmetic").toBeGreaterThan(0);
    for (const match of arithmetic) expect(Number(match[1]!)).toBe(SOAK_DAYS);

    // Completeness: strip every form §10 permits and require NOTHING to remain.
    // Without this a new phrasing ("a 48 hour deadline", "the rollback day")
    // would silently sit outside every sweep above.
    const strip = (patterns: readonly RegExp[]) => (text: string): string =>
      patterns.reduce((acc, p) => acc.replace(new RegExp(p.source, "giu"), " "), text);
    const residual = strip([...CONSTRAINED_HOURS, ...FREE_HOURS, ...CONSTRAINED_DAYS, ...FREE_DAYS])(
      SPEC.replace(/\s+/gu, " "),
    );
    expect(residual, "an hour quantity outside the forms §10 permits").not.toMatch(
      /\d+[- ]hours?\b/u,
    );
    expect(residual, "a day quantity outside the forms §10 permits").not.toMatch(/\d+[- ]days?\b/u);
    // ...and §10 must actually state those rules, so the doc explains its own
    // constraint rather than the constraint living only in this file.
    expect(SPEC.replace(/\s+/gu, " ")).toContain("every hour quantity is `within <N> hours`");
    expect(SPEC.replace(/\s+/gu, " ")).toContain("every day quantity is `<N> consecutive days`");

    // Both endpoints must be observable, not adjectival: a rollback is complete
    // only when the deployed engine reports v1, never when a variable was flipped.
    expect(SPEC).toContain('`modelConfiguration.assistantEngine` equal to `"v1"`');
    expect(SPEC).toContain("timestamp of the FIRST log line");
    // ...and the two criteria that emit NO line must have their own defined
    // start instants, or the deadline is undefined for 2 of the 13.
    expect(SPEC).toContain("Criterion 6 (heartbeat ABSENCE)");
    expect(SPEC).toContain("Criterion 13 (admin-reported data-integrity incident)");
    expect(SPEC).toContain("timestamp of the admin's report as received");
  });

  it("makes all four requiring documents point at the spec, carrying its window literal", () => {
    for (const path of REQUIRING_DOCS) {
      const doc = read(path);
      // Guard first: if the soak sentence is deleted, this must FAIL rather than
      // vacuously pass the link checks below.
      const soakMentions = [...doc.matchAll(/soak/giu)];
      expect(soakMentions.length, `${path} still requires a soak`).toBeGreaterThan(0);

      // The link target differs per document (root docs use `./docs/…`, docs/
      // documents use `./…`), so pin the basename and then RESOLVE the written
      // path relative to the document's own directory.
      const links = [...doc.matchAll(/\]\((\.[^)]*V2_SOAK_SPEC\.md)\)/gu)];
      expect(links.length, `${path} links the soak spec`).toBeGreaterThan(0);
      for (const link of links) {
        const target = resolve(join(dirname(resolve(path)), link[1]!));
        expect(existsSync(target), `${path} link ${link[1]!} resolves`).toBe(true);
        expect(target).toBe(resolve(SPEC_PATH));
      }

      // Double-entry literal, the convention `cold-verify-evidence.ts` uses: the
      // window is carried at the reference site, so a spec that silently changes
      // its window leaves four documents contradicting it and this test red.
      expect(doc, `${path} carries the soak window`).toContain(`${SOAK_DAYS}-day soak`);
      // ...and the literal must sit inside the link text, not somewhere else in
      // the file, or the coupling is decorative.
      expect(doc, `${path} couples the window to the link`).toMatch(
        new RegExp(`\\[${SOAK_DAYS}-day soak\\]\\(\\.[^)]*V2_SOAK_SPEC\\.md\\)`, "u"),
      );
    }
  });

  it("lets no other document state a different soak window or deadline", () => {
    const files = markdownFiles();
    // A zero-length sweep would pass everything.
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(SPEC_PATH);
    for (const file of files) {
      for (const match of read(file).matchAll(/(\d+)[- ]day soak/giu)) {
        expect(Number(match[1]!), `${file} states a soak window`).toBe(SOAK_DAYS);
      }
    }
    // The deadline is carried by the spec alone — no reference site restates it,
    // deliberately, because stuffing a second literal into four documents to pin
    // a value that lives in one place is worse than pinning it internally. This
    // is the guard for a future copy: a no-op today, red the moment one of the
    // requiring documents or the retirement gate states a conflicting number.
    for (const file of [...REQUIRING_DOCS, "docs/V1_RETIREMENT_SEQUENCE.md"]) {
      for (const match of read(file).replace(/\s+/gu, " ").matchAll(/rollback[^.]{0,120}?within (\d+) hours/giu)) {
        expect(Number(match[1]!), `${file} states a rollback deadline`).toBe(ROLLBACK_HOURS);
      }
    }
  });

  it("keeps the watch list set-equal to DEPLOYMENT.md's required-alert table", () => {
    const deployRows = matchStringsByRow(section(DEPLOY, "## Required alerts", "DEPLOYMENT.md"));
    const specRows = matchStringsByRow(section(SPEC, "## 5\\. The watch list", SPEC_PATH));

    // Neither parse may be silently empty, and the spec must cover EVERY alert
    // row — an alert row 11 added later fails here until the soak watches it.
    expect(deployRows.size, "DEPLOYMENT.md alert rows parsed").toBeGreaterThanOrEqual(10);
    expect([...specRows.keys()].sort((a, b) => a - b)).toEqual(
      [...deployRows.keys()].sort((a, b) => a - b),
    );

    for (const [row, expectedMatches] of deployRows) {
      expect(expectedMatches.length, `DEPLOYMENT.md row ${row} match strings`).toBeGreaterThan(0);
      // Set equality, not containment: an extra invented string in the watch
      // list is as wrong as a missing one — an operator would configure an alert
      // that can never fire and read its silence as health.
      expect(
        [...(specRows.get(row) ?? [])].sort(),
        `soak watch row ${row} match strings`,
      ).toEqual([...expectedMatches].sort());
    }
  });

  it("quotes every numeric threshold from the exported constant, not from prose", () => {
    expect(documented("RETENTION_PRUNE_FAILURE_THRESHOLD")).toBe(RETENTION_PRUNE_FAILURE_THRESHOLD);
    expect(documented("SUSTAINED_HOST_WINDOW_THRESHOLD")).toBe(SUSTAINED_HOST_WINDOW_THRESHOLD);
    expect(documented("SUSTAINED_HOST_WINDOW_MS")).toBe(SUSTAINED_HOST_WINDOW_MS);
    expect(documented("SUSTAINED_HOST_CONSECUTIVE_THRESHOLD")).toBe(
      SUSTAINED_HOST_CONSECUTIVE_THRESHOLD,
    );
    expect(documented("OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS")).toBe(
      OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS,
    );
    // Two values the runbook does NOT state in its own `NAME` = <number> form:
    // row 9 says "once per streak" and row 10 says "every 15 minutes" in words.
    // The spec is therefore their only document, and it says so — pin BOTH the
    // claim and its premise, so the sentence cannot quietly become false if the
    // runbook later grows a constants bullet for either.
    expect(documented("TOKEN_REJECTION_SUSPECT_THRESHOLD")).toBe(TOKEN_REJECTION_SUSPECT_THRESHOLD);
    expect(SPEC.replace(/\s+/gu, " ")).toContain(
      "Two of those six are values `DEPLOYMENT.md` does NOT state",
    );
    for (const name of ["TOKEN_REJECTION_SUSPECT_THRESHOLD", "OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS"]) {
      expect(DEPLOY, `DEPLOYMENT.md still does not pin ${name}`).not.toMatch(
        new RegExp(`\`${name}\`\\s*=`, "u"),
      );
      expect(SPEC, `the spec names ${name} as its own`).toContain(name);
    }
    // ...and the four the runbook DOES pin must stay pinned there, or the split
    // this sentence describes has moved and the spec is describing a stale one.
    for (const name of [
      "RETENTION_PRUNE_FAILURE_THRESHOLD",
      "SUSTAINED_HOST_WINDOW_THRESHOLD",
      "SUSTAINED_HOST_WINDOW_MS",
      "SUSTAINED_HOST_CONSECUTIVE_THRESHOLD",
    ]) expect(DEPLOY, `DEPLOYMENT.md still pins ${name}`).toMatch(new RegExp(`\`${name}\`\\s*=`, "u"));
  });

  it("never treats a missing drain-recovery line as a signal (it cannot exist)", () => {
    // The defect this pins: `ready_recovered` CANNOT follow a drain, so any
    // criterion phrased as "a drain that does not recover" fires on every
    // routine deploy and starts the v1-rollback clock. Pin the CODE that makes
    // it structural, then pin that the spec never phrases it that way.
    const readiness = readFileSync(resolve("src/readiness-alerts.ts"), "utf8");
    // `ready()` is silent unless THIS process already opened a cause...
    expect(readiness).toMatch(/ready\(\)\s*\{\s*\n\s*if \(openCause === undefined\) return;/u);
    // ...and the monitor's state is per-instance, not module-level.
    expect(readiness).toContain("let openCause: ReadinessFailureCause | undefined;");
    const server = read("src/server.ts");
    // Exactly one monitor per process, and the drain path never calls ready().
    expect(server.match(/createReadinessAlertMonitor\(/gu)).toHaveLength(1);
    expect(server).toContain('readinessAlerts.notReady("draining")');
    expect(server).toMatch(/readiness\.ready = false;/u);
    expect(server).not.toMatch(/readiness\.ready = true;/u);

    const normalized = SPEC.replace(/\s+/gu, " ");
    // The spec must state the limit...
    expect(normalized).toContain("cannot cross a process boundary");
    expect(normalized).toContain("a `cause=draining` line is NEVER followed by");
    // ...and must NOT contain the criterion shape that would fire on deploys.
    expect(normalized, "a drain must never be required to emit a recovery line").not.toMatch(
      /`cause=draining` that is not followed by/u,
    );
    expect(normalized, "row 1 must not abort on a drain that never recovers").not.toMatch(
      /draining cause that never recovers/u,
    );
    // Criterion 11 must exclude draining explicitly and carry a bound, so it is
    // neither the deploy-firing shape nor an open-ended one.
    expect(normalized).toContain(
      "**A `cause=draining` line is explicitly NOT this criterion**",
    );
    // Criterion 11 must carry an explicit bound. (The alternation an earlier
    // draft used here made the left branch match "criterion 11" alone, so the
    // assertion proved nothing — a single-branch pattern is the whole point.)
    expect(normalized).toContain(
      "within one `OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS`. That bound is this spec's choice",
    );
    // §7.2's deploy case must be reachable: resolution read from /health.
    expect(normalized).toContain("where `/health` answers `200` again once the replacement");
  });

  it("commits the deadline to a rollback path that can actually execute", () => {
    const normalized = SPEC.replace(/\s+/gu, " ");
    // The runbook's own banner says the literal read-through does not execute;
    // the spec must name that, not present it as the path.
    const banner = read("docs/marketplace/03-operations-evidence-rollback-package.md");
    expect(banner).toContain("**This page is not an executable v1 rollback either.**");
    expect(banner).toContain("planSignedFullV1Rollback");
    expect(normalized).toContain("**This page is not an executable v1 rollback either.**");
    expect(normalized).toContain("throws before any Railway mutation");
    // The real path exists in code and is named, with ADR 003's extra step.
    const cutover = read("scripts/cutover-transaction.ts");
    expect(cutover).toContain("export function planSignedFullV1Rollback(");
    expect(cutover).toContain("clearsStaleInstallation: true");
    expect(normalized).toContain("**`planSignedFullV1Rollback`**");
    expect(normalized).toContain("`clearsStaleInstallation`");
    // The blocking prerequisite must be stated, and must still BE blocking. D9
    // landed, so the file now exists — but flipping this assertion to `true`
    // alone would trade a real gate for a green test. The spec must still name
    // the exact runbook AND the exact section that walks the plan, and that
    // section must be there.
    const v2RunbookPath = "docs/marketplace/03-operations-v2-runbook.md";
    expect(existsSync(resolve(v2RunbookPath))).toBe(true);
    expect(normalized).toContain(v2RunbookPath);
    expect(normalized).toContain('**"Application rollback: the signed full v1 return"**');
    const v2Runbook = read(v2RunbookPath);
    expect(v2Runbook).toContain("## Application rollback: the signed full v1 return");
    expect(v2Runbook).toContain("planSignedFullV1Rollback");
    expect(v2Runbook).toContain("clearStaleInstallationSql");

    // Entry-gate item 3 must not claim the deploy transaction's own UNDO proves
    // v1 reachability. Those two names are pinned to the SERVING tree, which
    // during a v2 soak is v2.
    const gate = slice("## 2. Entry gate", "## 3. Duration").replace(/\s+/gu, " ");
    expect(gate).toContain("This is NOT the `ROLLBACK_RELEASE_SHA`");
    expect(gate).toContain("can never name v1");
    // The gate item now names the document that satisfies it, and keeps a
    // condition that a bare `existsSync` cannot satisfy: the plan inputs must be
    // suppliable, because `planSignedFullV1Rollback` throws on the gap.
    expect(gate).toContain(v2RunbookPath);
    expect(gate).toContain("Application rollback: the signed full v1 return");
    expect(gate).toContain("does not satisfy this item");
    expect(DEPLOY).toContain('test "$ROLLBACK_RELEASE_SHA" = "$SERVING_RELEASE_SHA"');
  });

  it("says which lines cannot be attributed to a workspace", () => {
    // Four row-10 criteria and the headline row-5 criterion are the load-bearing
    // ones, and neither line reliably carries a workspace. An operator planning
    // per-workspace triage on them would be planning something impossible.
    const outcome = read("src/log-outcome-unknown.ts");
    expect(outcome).toContain("`workspace=` is absent at seams with no reachable session");
    expect(outcome).toContain("it carries no workspace alias");
    expect(DEPLOY).toContain("Row 10 goes further and carries NO workspace dimension at all");
    const normalized = SPEC.replace(/\s+/gu, " ");
    expect(normalized).toContain("cannot always name a workspace");
    expect(normalized).toContain("not** an operator lookup key");
    // ...and the artifact must not demand one anyway.
    expect(normalized).toContain("an invented attribution is worse than \"not attributable\"");
  });

  it("carries the watch list's documented blind spots rather than reading as complete", () => {
    // Each of these limits is recorded in DEPLOYMENT.md or in src; a soak that
    // does not carry them is a soak whose clean result is over-read.
    for (const limit of [
      "Row 3's streak is per process",
      "Row 6 counts only ANSWERED responses",
      "Row 6 needs volume",
      "Row 6's latches are per process",
      "pinned by SOURCE only",
      "The force-exit path is silent",
      "Row 10's LEVEL fields are instantaneous",
      "Row 10's windows do not tile",
      "Row 10's first line after a restart is distorted",
      "Nothing asserts at BOOT that the timers were created",
      "OWNER VERIFICATION REQUIRED",
      "cannot cross a process boundary",
      "cannot always name a workspace",
    ]) expect(SPEC, `the spec carries the limit: ${limit}`).toContain(limit);

    // Attribution: §6 claims three limits are NOT in the runbook. That claim is
    // itself checkable, and it was WRONG once — the un-asserted timer creation
    // IS stated in DEPLOYMENT.md. Pin both directions.
    for (const absent of ["force-exit", "ready_recovered` cannot cross"]) {
      expect(DEPLOY, `DEPLOYMENT.md still does not cover: ${absent}`).not.toContain(absent);
    }
    expect(DEPLOY, "DEPLOYMENT.md still states the timer limit").toContain(
      "Nothing asserts at BOOT that `start()` made",
    );
    expect(SPEC.replace(/\s+/gu, " "), "the spec attributes the timer limit correctly").toContain(
      "Every other bullet, including the un-asserted timer creation, is stated in the runbook",
    );

    // The force-exit limit is a claim about real code, so pin the code: the
    // timer's callback must still be the bare `finish(1)` with no log call.
    const server = read("src/server.ts");
    expect(server).toMatch(/setTimeout\(\(\) => finish\(1\), deps\.forceExitAfterMs/u);
    const forceLine = server.split("\n").find((line) => line.includes("=> finish(1)"))!;
    expect(forceLine).not.toContain("log(");
  });

  it("states abort criteria as counted, observable conditions the artifact must answer", () => {
    const immediate = slice("### 7.1 IMMEDIATE ABORT", "### 7.2 INVESTIGATE");
    const investigate = slice("### 7.2 INVESTIGATE", "## 8.");
    const count = (body: string): number => body.split("\n").filter((l) => /^\d+\. /u.test(l)).length;
    const immediateCount = count(immediate);
    const investigateCount = count(investigate);
    expect(immediateCount).toBeGreaterThan(0);
    expect(investigateCount).toBeGreaterThan(0);

    // The declaration artifact must require one verdict per criterion. Stating
    // the counts in two places on purpose: adding a criterion without widening
    // the artifact would let a soak be declared with a criterion unanswered.
    const declared = /§7\.1 criterion \((\d+) entries\) and per §7\.2 criterion \((\d+) entries\)/u
      .exec(SPEC.replace(/\s+/gu, " "));
    expect(declared, "the artifact states how many verdicts it requires").not.toBeNull();
    expect(Number(declared![1]!)).toBe(immediateCount);
    expect(Number(declared![2]!)).toBe(investigateCount);

    // The headline criterion the task exists for: this string appearing AT ALL.
    expect(immediate).toContain("`[write-outcome] event=outcome_unknown` appears at all");
  });

  it("agrees with the v1 retirement sequence's entry gate in both directions", () => {
    const retirement = read("docs/V1_RETIREMENT_SEQUENCE.md");
    // The gate is what consumes this spec, so the reference must survive.
    expect(retirement).toContain("docs/V2_SOAK_SPEC.md");

    // Its three demands on the declaration artifact, each answered by the spec.
    for (const [demand, answer] of [
      ["named inputs", "named inputs"],
      ["watch-list results", "watchListResults"],
      ['"no rollback required"', '**"no rollback required"**'],
    ] as const) {
      expect(retirement, `the gate still demands ${demand}`).toContain(demand);
      expect(SPEC, `the spec supplies ${demand}`).toContain(answer);
    }

    // Gate item 3 binds the window to ONE deployed candidate; the spec turns that
    // into an executable rule instead of leaving it to interpretation.
    expect(retirement).toContain("full soak window on the exact retirement");
    expect(SPEC).toContain("restarts the 7-day\nclock at zero");
    expect(SPEC).toContain("deploymentLedger");

    // The spec QUOTES that gate. A quote is only a quote while the source still
    // says it — inserting anything mid-phrase (a link, a clause) would leave the
    // spec misquoting the document it cites, which is how this first broke.
    const quoted = /requires that production served v2 "([^"]+)"/u.exec(SPEC.replace(/\s+/gu, " "));
    expect(quoted, "the spec quotes the retirement gate").not.toBeNull();
    expect(
      retirement.replace(/\s+/gu, " "),
      "the retirement gate still contains the quoted phrase verbatim",
    ).toContain(quoted![1]!);

    // The interlock: gate item 2 rewrites DEPLOYMENT.md's v1-rollback block, and
    // doing that during the soak would delete the procedure the 24-hour deadline
    // commits to. The spec must forbid it explicitly, or the two documents
    // contradict each other the first time an operator reads them in order.
    expect(SPEC).toContain("may not execute before or during the soak");
    expect(DEPLOY).toContain("ONLY for a v1 deploy or a v1 rollback");

    // The retirement document contradicts ITSELF about where that rewrite sits:
    // entry-gate item 2 says "BEFORE step 1 below", while step 1 IS the rewrite.
    // The spec must not paper over that by asserting one reading as fact. Pin
    // both halves of the contradiction so this stays flagged until the
    // retirement document's owner resolves it — and pin that the spec flags it
    // rather than restating either half as the ordering.
    expect(retirement).toContain("must be rewritten BEFORE step 1 below, not after");
    expect(retirement).toMatch(/### 1\. Rewrite `DEPLOYMENT\.md`'s rollback block/u);
    const normalized = SPEC.replace(/\s+/gu, " ");
    expect(normalized).toContain("the retirement document is internally inconsistent");
    expect(normalized).toContain("This spec takes no position on that internal ordering");
    expect(normalized, "the spec must not assert the disputed ordering as fact").not.toContain(
      "The retirement sequence orders the rewrite as its step 1",
    );
  });

  it("names the declaration artifact's inputs in the existing evidence convention", () => {
    const artifact = slice("## 9. The declaration artifact", "## 10. Anchors");
    for (const field of [
      "candidateSha",
      "deployIdentity",
      "windowStart",
      "windowEnd",
      "deploymentLedger",
      "watchListResults",
      "heartbeatObserved",
      "abortCriteriaVerdict",
      "logPlaneAccess",
      "knownBlindSpots",
      "rollback",
      "conclusion",
    ]) expect(artifact, `the artifact names ${field}`).toContain(field);

    // It must bind deploy identity through the validator that already exists...
    expect(artifact).toContain("verifyDeployedV2Engine");
    expect(existsSync(resolve("scripts/evidence/v2-deployed-engine.ts"))).toBe(true);
    // ...and must NOT invent a builder. If one is ever written it is a v2
    // sibling; the v1 validators are rollback evidence and stay untouched.
    expect(artifact).toContain("No builder script exists for this artifact");
    expect(artifact).toContain("scripts/evidence/v2-*.ts");
    const invented = [...artifact.matchAll(/npm run ([a-z0-9:-]+)/gu)].map((m) => m[1]!);
    const scripts = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    for (const name of invented) expect(Object.keys(scripts.scripts)).toContain(name);
  });

  it("keeps its entry gate stated by content, not by a plan label that does not exist", () => {
    // Same class as the `CF-1` lesson: `E5` is a label in an out-of-repo executor
    // plan. The gate must be checkable from this repository alone.
    const gate = slice("## 2. Entry gate", "## 3. Duration");
    expect(gate).toContain("verifyDeployedV2Engine");
    expect(gate).toContain('`"v2"`');
    expect(gate).toContain("deploy:private-production");
    expect(gate).toContain("that label exists");
    for (const probe of ["/live", "/health", "/manifest"]) expect(gate).toContain(probe);
    // Every npm script the gate names must be real.
    const scripts = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    for (const match of gate.matchAll(/npm run ([a-z0-9:-]+)/gu)) {
      expect(Object.keys(scripts.scripts)).toContain(match[1]!);
    }
  });
});
