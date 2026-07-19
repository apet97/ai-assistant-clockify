import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(resolve(path), "utf8");

describe("release operations contract", () => {
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
