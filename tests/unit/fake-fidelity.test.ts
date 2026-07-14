import { describe, expect, it } from "vitest";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

/**
 * The fake WorkspaceClient must honor the same defaults the REAL adapters put
 * on the wire, or integration tests can pass against semantics live Clockify
 * never has (the fixture-self-confirmation class). The real listProjects/
 * listTags always send `archived=false` unless a filter is given
 * (src/clockify/rest/projects.ts, tags.ts) — so the fake's default list must
 * be ACTIVE-ONLY too.
 */
describe("fake WorkspaceClient fidelity to the real adapters", () => {
  const seed = () => ({
    projects: [
      { id: "p1", name: "Active P" },
      { id: "p2", name: "Old P", archived: true },
    ],
    tags: [
      { id: "t1", name: "Active T" },
      { id: "t2", name: "Old T", archived: true },
    ],
  });

  it("listProjects() with no filter returns ACTIVE-ONLY (the real adapter wires archived=false by default)", async () => {
    const fake = createFakeWorkspace(seed());
    const rows = await fake.client.listProjects();
    expect(rows.rows.map((p) => p.id)).toEqual(["p1"]);
    const archived = await fake.client.listProjects({ archived: true });
    expect(archived.rows.map((p) => p.id)).toEqual(["p2"]);
  });

  it("listTags() with no filter returns ACTIVE-ONLY (the real adapter wires archived=false by default)", async () => {
    const fake = createFakeWorkspace(seed());
    const rows = await fake.client.listTags();
    expect(rows.rows.map((t) => t.id)).toEqual(["t1"]);
    const archived = await fake.client.listTags({ archived: true });
    expect(archived.rows.map((t) => t.id)).toEqual(["t2"]);
  });

  it("deleteEntity() actually removes the row (the real adapter archive-then-deletes — undo of a creation truly removes it)", async () => {
    const fake = createFakeWorkspace(seed());
    await fake.client.deleteEntity!({ entityType: "project", id: "p1" });
    // Gone from BOTH the active and the archived view — not merely recorded.
    expect((await fake.client.listProjects()).rows.some((p) => p.id === "p1")).toBe(false);
    expect((await fake.client.listProjects({ archived: true })).rows.some((p) => p.id === "p1")).toBe(false);
    await fake.client.deleteEntity!({ entityType: "tag", id: "t1" });
    expect((await fake.client.listTags()).rows.some((t) => t.id === "t1")).toBe(false);
  });
});
