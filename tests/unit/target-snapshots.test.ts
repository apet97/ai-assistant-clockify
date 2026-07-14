import { describe, expect, it, vi } from "vitest";
import {
  captureTargetSnapshot,
  resolveAuthoritativeTarget,
  verifyTargetSnapshots,
} from "../../src/harness/target-snapshots.js";

describe("authoritative target snapshots", () => {
  const target = { type: "project", id: "0123456789abcdef01234567", name: "Roadmap" };

  it("fetches direct-looking ids and rejects a syntactically valid id that is absent", async () => {
    const fetchById = vi.fn().mockResolvedValue(undefined);
    const result = await resolveAuthoritativeTarget({
      requested: target.id,
      type: "project",
      fetchById,
      searchByName: vi.fn(),
      project: (row: { id: string; name: string }) => ({ id: row.id, name: row.name }),
    });

    expect(fetchById).toHaveBeenCalledWith(target.id);
    expect(result).toMatchObject({ ok: false, code: "target_not_found" });
  });

  it("does not establish identity from a truncated name search", async () => {
    const result = await resolveAuthoritativeTarget({
      requested: "Roadmap",
      type: "project",
      fetchById: vi.fn(),
      searchByName: vi.fn().mockResolvedValue({ rows: [{ id: target.id, name: "Roadmap" }], truncated: true }),
      project: (row: { id: string; name: string }) => ({ id: row.id, name: row.name }),
    });

    expect(result).toMatchObject({ ok: false, code: "target_evidence_incomplete" });
  });

  it("detects changed targets and parents immediately before dispatch", async () => {
    const snapshots = [
      captureTargetSnapshot("target", target, { name: "Roadmap", archived: false }),
      captureTargetSnapshot("parent", { type: "client", id: "client-1", name: "Acme" }, { name: "Acme" }),
    ];
    const changedTarget = await verifyTargetSnapshots(snapshots, async (snapshot) => ({
      ref: snapshot.ref,
      projection: snapshot.relation === "target" ? { name: "Roadmap v2", archived: false } : { name: "Acme" },
    }));
    expect(changedTarget).toMatchObject({ ok: false, code: "stale_target", requiresFreshPreview: true });

    const changedParent = await verifyTargetSnapshots(snapshots, async (snapshot) => ({
      ref: snapshot.ref,
      projection: snapshot.relation === "parent" ? { name: "Other" } : { name: "Roadmap", archived: false },
    }));
    expect(changedParent).toMatchObject({ ok: false, code: "stale_parent", requiresFreshPreview: true });
  });

  it.each([undefined, { ref: target, truncated: true }])(
    "fails closed without complete pre-dispatch evidence (%s)",
    async (evidence) => {
      const snapshot = captureTargetSnapshot("target", target, { name: "Roadmap" });
      const result = await verifyTargetSnapshots([snapshot], async () => evidence);
      expect(result).toMatchObject({ ok: false, code: "stale_target", requiresFreshPreview: true });
    },
  );

  it("fails closed when a target-verification call carries no snapshots", async () => {
    const fetch = vi.fn();
    const result = await verifyTargetSnapshots([], fetch);
    expect(result).toMatchObject({ ok: false, code: "stale_target", requiresFreshPreview: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates deterministic sanitized snapshots", () => {
    const a = captureTargetSnapshot("target", target, { name: "Roadmap", token: "secret", bytes: new Uint8Array([1, 2]) });
    const b = captureTargetSnapshot("target", target, { bytes: new Uint8Array([9]), token: "other", name: "Roadmap" });
    expect(a.projection).toEqual({ name: "Roadmap" });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("bounds projections and rejects evidence for a different entity", async () => {
    const snapshot = captureTargetSnapshot("target", target, { note: "x".repeat(200_000) });
    expect(Buffer.byteLength(JSON.stringify(snapshot.projection), "utf8")).toBeLessThanOrEqual(65_536);
    const result = await verifyTargetSnapshots([snapshot], async () => ({
      ref: { ...target, id: "different" },
      projection: { note: "x".repeat(200_000) },
    }));
    expect(result).toMatchObject({ ok: false, code: "stale_target" });
  });

  it("fingerprints the complete nonsecret projection beyond persisted preview bounds", async () => {
    const prefix = "x".repeat(70_000);
    const original = { note: `${prefix}A`, rows: [...Array.from({ length: 140 }, (_, index) => index), "original"] };
    const snapshot = captureTargetSnapshot("target", target, original);
    expect(Buffer.byteLength(JSON.stringify(snapshot.projection), "utf8")).toBeLessThanOrEqual(65_536);

    const longTailDrift = await verifyTargetSnapshots([snapshot], async () => ({
      ref: target,
      projection: { ...original, note: `${prefix}B` },
    }));
    expect(longTailDrift).toMatchObject({ ok: false, code: "stale_target" });

    const lateArrayDrift = await verifyTargetSnapshots([snapshot], async () => ({
      ref: target,
      projection: { ...original, rows: [...Array.from({ length: 140 }, (_, index) => index), "changed"] },
    }));
    expect(lateArrayDrift).toMatchObject({ ok: false, code: "stale_target" });
  });

  it("preserves complete evidence through authoritative resolve before bounded capture", async () => {
    const rows = [...Array.from({ length: 140 }, (_, index) => index), "original"];
    const resolved = await resolveAuthoritativeTarget({
      requested: target.id,
      type: "project",
      fetchById: vi.fn().mockResolvedValue({ ...target, note: `${"x".repeat(70_000)}A`, rows }),
      searchByName: vi.fn(),
      project: (row: typeof target & { note: string; rows: Array<number | string> }) => ({
        id: row.id,
        name: row.name,
        projection: { note: row.note, rows: row.rows },
      }),
    });
    if (!resolved.ok) throw new Error("expected resolved target");
    expect((resolved.projection as { rows: unknown[] }).rows).toHaveLength(141);
    const snapshot = captureTargetSnapshot("target", resolved.ref, resolved.projection);
    const verification = await verifyTargetSnapshots([snapshot], async () => ({
      ref: resolved.ref,
      projection: { note: `${"x".repeat(70_000)}A`, rows: [...Array.from({ length: 140 }, (_, index) => index), "changed"] },
    }));
    expect(verification).toMatchObject({ ok: false, code: "stale_target" });
  });

  it.each([
    [{ rows: [], truncated: false }, "target_not_found"],
    [{ rows: [{ id: "1", name: "Roadmap" }, { id: "2", name: "roadmap" }], truncated: false }, "target_ambiguous"],
    [{ rows: [{ id: "1", name: "Roadmap extended" }], truncated: false }, "target_not_found"],
  ] as const)("requires one exact symbolic target (%s)", async (search, code) => {
    const result = await resolveAuthoritativeTarget({
      requested: "Roadmap",
      type: "project",
      fetchById: vi.fn(),
      searchByName: vi.fn().mockResolvedValue(search),
      project: (row: { id: string; name: string }) => ({ id: row.id, name: row.name }),
    });
    expect(result).toMatchObject({ ok: false, code });
  });
});
