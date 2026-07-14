import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/db/store.js";

describe("short-lived artifacts", () => {
  it("binds bytes to workspace, admin, session and expires them after 60 minutes", () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    const store = createStore(":memory:", { now: () => now });
    const session = store.createSession({ workspaceId: "ws1", adminUserId: "a1" });
    const created = store.createArtifact({
      workspaceId: "ws1",
      adminUserId: "a1",
      sessionId: session.id,
      contentType: "application/pdf",
      filename: "invoice.pdf",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(store.getArtifact(created.id, "ws1", "a1", session.id)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.getArtifact(created.id, "ws1", "other", session.id)).toBeUndefined();
    now = new Date("2026-07-14T11:00:00.001Z");
    expect(store.getArtifact(created.id, "ws1", "a1", session.id)).toBeUndefined();
    store.close();
  });

  it("accepts an artifact at the exact 1,000,000-byte boundary", () => {
    const store = createStore(":memory:");
    const created = store.createArtifact({
      workspaceId: "ws1",
      adminUserId: "a1",
      sessionId: "s1",
      contentType: "application/pdf",
      filename: "boundary.pdf",
      bytes: new Uint8Array(1_000_000),
    });

    expect(store.getArtifact(created.id, "ws1", "a1", "s1")?.bytes.byteLength).toBe(1_000_000);
    store.close();
  });

  it("refuses an artifact over the hard limit without persisting a row", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-limit-"));
    const dbPath = join(dir, "artifact.sqlite");
    try {
      const store = createStore(dbPath);
      expect(() => store.createArtifact({
        workspaceId: "ws1",
        adminUserId: "a1",
        sessionId: "s1",
        contentType: "application/pdf",
        filename: "big.pdf",
        bytes: new Uint8Array(1_000_001),
      })).toThrow(/artifact_too_large/);
      store.close();

      const raw = new Database(dbPath, { readonly: true });
      expect(raw.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
