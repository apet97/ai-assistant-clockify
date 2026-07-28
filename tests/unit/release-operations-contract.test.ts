import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
      const versionProbe = runbook.indexOf('curl --fail --silent --show-error "$BASE_URL/version"');
      expect(versionProbe, `${path} deployed version probe`).toBeGreaterThanOrEqual(0);
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
