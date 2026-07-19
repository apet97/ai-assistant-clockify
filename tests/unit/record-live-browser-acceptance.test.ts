import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FEATURE_GROUPS } from "../../src/harness/permissions.js";
import { recordLiveBrowserAcceptanceFromFiles } from "../../scripts/evidence/record-live-browser-acceptance.js";

const SHA = {
  candidate: "a".repeat(40),
  archive: "b".repeat(64),
  server: "c".repeat(64),
  binding: "d".repeat(64),
};

const source = {
  commitSha: SHA.candidate,
  releaseBuildHash: SHA.archive,
  serverArtifactSha256: SHA.server,
  sourceRelationship: "source_bound_builder",
  sourceBindingSha256: SHA.binding,
};

function trace() {
  return {
    schemaVersion: 1,
    kind: "sanitized_browser_automation_trace",
    startedAt: "2026-07-19T10:00:00.000Z",
    completedAt: "2026-07-19T10:10:00.000Z",
    deployedVersionObservedAt: "2026-07-19T10:00:01.000Z",
    runtime: { browser: "Google Chrome", browserVersion: "140.0.7339.42", surface: "clockify_embedded_iframe" },
    journeys: {
      firstRun: { disclosureVisible: true, permissionsSaved: true, permissionGroupCount: FEATURE_GROUPS.length },
      admin: { componentLoaded: true, role: "OWNER" },
      read: { receiptVisible: true },
      safeWrite: { receiptVisible: true },
      undo: { receiptVisible: true, effectAbsent: true },
      riskyCancel: { previewVisible: true, cancelled: true, effectPreserved: true },
      riskyConfirm: { previewVisible: true, confirmed: true, receiptVisible: true, effectAbsent: true },
      history: { conversationSwitched: true, contentRestored: true },
      reload: { contentRestored: true, operationCardsRestored: true },
      pdf: {
        actionVisible: true,
        downloadCompleted: true,
        filenameExtension: ".pdf",
        contentType: "application/pdf",
        signature: "%PDF-",
        bytes: 128,
        authenticatedStatus: 200,
        unauthenticatedStatus: 401,
      },
    },
    cleanup: { resourcePrefix: "AIASSIST_SMOKE_", created: 4, deletionProven: 4, remaining: 0, pendingPreviews: 0 },
  };
}

describe("live browser acceptance recorder", () => {
  it("hashes the exact sanitized automation output and atomically records derived source/member binding", () => {
    const root = mkdtempSync(join(tmpdir(), "live-browser-recorder-"));
    const paths = {
      tracePath: join(root, "sanitized-browser-result.json"),
      memberDenialPath: join(root, "member-denial.json"),
      deployedVersionPath: join(root, "deployed-version.json"),
      outputPath: join(root, "production-browser.json"),
    };
    const traceBytes = `${JSON.stringify(trace(), null, 2)}\n`;
    writeFileSync(paths.tracePath, traceBytes);
    writeFileSync(paths.memberDenialPath, JSON.stringify({
      schemaVersion: 1,
      kind: "production_member_denial",
      conclusion: "passed",
      source,
      observedAt: "2026-07-19T10:05:00.000Z",
      role: "MEMBER",
      authorityPath: "verified_installation_to_member_exchange",
      componentStatus: 403,
      sessionCookieIssued: false,
      adminOnlyResponse: true,
    }));
    writeFileSync(paths.deployedVersionPath, JSON.stringify({
      version: "1.0.0",
      releaseSha: SHA.candidate,
      buildHash: SHA.archive,
      serverArtifactSha256: SHA.server,
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: SHA.binding,
    }));

    const recorded = recordLiveBrowserAcceptanceFromFiles({
      ...paths,
      expectedCandidateSha: SHA.candidate,
    });

    expect(recorded.source).toEqual(source);
    expect(recorded.capture.sha256).toBe(createHash("sha256").update(traceBytes).digest("hex"));
    expect(JSON.parse(readFileSync(paths.outputPath, "utf8"))).toEqual(recorded);
  });

  it("rejects an off-worktree output whose parent symlink resolves into the worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "live-browser-recorder-link-"));
    const worktreeRoot = join(root, "worktree");
    const inputRoot = join(root, "inputs");
    mkdirSync(worktreeRoot);
    mkdirSync(inputRoot);
    const linkedParent = join(root, "apparently-external-output");
    symlinkSync(worktreeRoot, linkedParent, "dir");
    const paths = {
      tracePath: join(inputRoot, "sanitized-browser-result.json"),
      memberDenialPath: join(inputRoot, "member-denial.json"),
      deployedVersionPath: join(inputRoot, "deployed-version.json"),
      outputPath: join(linkedParent, "production-browser.json"),
    };
    writeFileSync(paths.tracePath, `${JSON.stringify(trace(), null, 2)}\n`);
    writeFileSync(paths.memberDenialPath, JSON.stringify({
      schemaVersion: 1,
      kind: "production_member_denial",
      conclusion: "passed",
      source,
      observedAt: "2026-07-19T10:05:00.000Z",
      role: "MEMBER",
      authorityPath: "verified_installation_to_member_exchange",
      componentStatus: 403,
      sessionCookieIssued: false,
      adminOnlyResponse: true,
    }));
    writeFileSync(paths.deployedVersionPath, JSON.stringify({
      version: "1.0.0",
      releaseSha: SHA.candidate,
      buildHash: SHA.archive,
      serverArtifactSha256: SHA.server,
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: SHA.binding,
    }));

    expect(() => recordLiveBrowserAcceptanceFromFiles({
      ...paths,
      expectedCandidateSha: SHA.candidate,
      worktreeRoot,
    })).toThrow(/output|worktree|unsafe/u);
    expect(existsSync(join(worktreeRoot, "production-browser.json"))).toBe(false);
  });

  it("rejects an input inside a worktree even when the supplied worktree root is a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "live-browser-recorder-root-link-"));
    const realWorktree = join(root, "real-worktree");
    const linkedWorktree = join(root, "linked-worktree");
    const external = join(root, "external");
    mkdirSync(realWorktree);
    mkdirSync(external);
    symlinkSync(realWorktree, linkedWorktree, "dir");
    const paths = {
      tracePath: join(realWorktree, "sanitized-browser-result.json"),
      memberDenialPath: join(external, "member-denial.json"),
      deployedVersionPath: join(external, "deployed-version.json"),
      outputPath: join(external, "production-browser.json"),
    };
    writeFileSync(paths.tracePath, `${JSON.stringify(trace(), null, 2)}\n`);
    writeFileSync(paths.memberDenialPath, "{}\n");
    writeFileSync(paths.deployedVersionPath, "{}\n");

    expect(() => recordLiveBrowserAcceptanceFromFiles({
      ...paths,
      expectedCandidateSha: SHA.candidate,
      worktreeRoot: linkedWorktree,
    })).toThrow(/trace|unsafe|worktree/u);
    expect(existsSync(paths.outputPath)).toBe(false);
  });
});
