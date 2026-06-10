import { describe, expect, it } from "vitest";
import { looksLikeClockifyId, resolveEntityRef } from "../../src/harness/workflows/resolve.js";

const HEX_ID = "5f1e2d3c4b5a69788796a5b4";

describe("looksLikeClockifyId", () => {
  it("accepts a 24-hex Mongo ObjectId", () => {
    expect(looksLikeClockifyId(HEX_ID)).toBe(true);
    expect(looksLikeClockifyId(HEX_ID.toUpperCase())).toBe(true);
  });

  it("rejects names and invoice numbers that landed in the id slot", () => {
    expect(looksLikeClockifyId("AIASSIST_LOOP_P4")).toBe(false);
    expect(looksLikeClockifyId("INV-20260610021808")).toBe(false);
    expect(looksLikeClockifyId("Deep Work")).toBe(false);
    expect(looksLikeClockifyId("")).toBe(false);
  });
});

describe("resolveEntityRef", () => {
  const items = [
    { id: "p1", name: "Website Redesign" },
    { id: "p2", name: "Mobile App" },
    { id: "p3", name: "Old Site", archived: true },
  ];
  const list = async () => items;

  it("passes a real-looking id straight through without listing", async () => {
    let listed = 0;
    const result = await resolveEntityRef(
      { id: HEX_ID },
      { noun: "project", verb: "update", list: async () => (listed++, items) },
    );
    expect(result).toMatchObject({ ok: true, id: HEX_ID });
    expect(listed).toBe(0);
  });

  it("resolves a NAME passed in the id slot (the audit-log failure shape)", async () => {
    const result = await resolveEntityRef(
      { id: "Website Redesign" },
      { noun: "project", verb: "update", list },
    );
    expect(result).toMatchObject({ ok: true, id: "p1", name: "Website Redesign" });
  });

  it("keeps working when a NON-hex id is a real id (exact-id fallback)", async () => {
    const result = await resolveEntityRef({ id: "p2" }, { noun: "project", verb: "update", list });
    expect(result).toMatchObject({ ok: true, id: "p2", name: "Mobile App" });
  });

  it("resolves an explicit name (case-insensitive)", async () => {
    const result = await resolveEntityRef(
      { name: "mobile app" },
      { noun: "project", verb: "delete", list },
    );
    expect(result).toMatchObject({ ok: true, id: "p2", name: "Mobile App" });
  });

  it("clarifies with grounded options when nothing matches", async () => {
    const result = await resolveEntityRef(
      { name: "Webside" },
      { noun: "project", verb: "update", list },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.clarify.clarify).toContain('"Webside"');
      expect(result.clarify.options?.map((o) => o.id)).toContain("p1");
    }
  });

  it("clarifies (never picks) when several active entities share the name", async () => {
    const dupes = [
      { id: "a", name: "Focus" },
      { id: "b", name: "Focus" },
    ];
    const result = await resolveEntityRef(
      { name: "Focus" },
      { noun: "tag", verb: "delete", list: async () => dupes },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.clarify.options?.length).toBe(2);
  });

  it("ignores archived entities when resolving by name", async () => {
    const result = await resolveEntityRef(
      { name: "Old Site" },
      { noun: "project", verb: "update", list },
    );
    expect(result.ok).toBe(false);
  });
});
