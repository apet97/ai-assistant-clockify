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
      const upload = runbook.indexOf('railway up "$RELEASE_STAGING"', canonical);
      expect(canonical, `${path} canonical release order`).toBeGreaterThanOrEqual(0);
      expect(gate, `${path} encrypted-backup gate`).toBeGreaterThan(canonical);
      expect(upload, `${path} production upload`).toBeGreaterThan(gate);
      expect(runbook.slice(gate, upload)).toContain("STOP: do not run Railway upload");
    }
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

  it("uses Railway file APIs and direct argv commands without a remote shell", () => {
    for (const path of ["DEPLOYMENT.md", "docs/marketplace/03-operations-evidence-rollback-package.md"]) {
      const runbook = read(path);
      expect(runbook).toContain("Railway CLI 5.27.0");
      expect(runbook).toContain("railway service files");
      expect(runbook).toContain('download "${REMOTE_BACKUP}${suffix}" "$partial_path"');
      expect(runbook).toContain('delete "${REMOTE_BACKUP}${suffix}" --yes');
      expect(runbook).not.toContain("sh -lc");
      expect(runbook).not.toContain("| /usr/bin/base64 -D");
    }
  });

  it("keeps restore-verifier stdout machine-readable while rebuilding the exact artifact", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:verify-restore"]).toContain("npm run build 1>&2");
    expect(pkg.scripts["db:verify-restore"]).toContain("tsx scripts/verify-restored-db.ts");
  });
});
