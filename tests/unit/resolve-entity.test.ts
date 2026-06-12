import { describe, expect, it } from "vitest";
import { looksLikeClockifyId, resolveEntityRef, resolveUserRefs } from "../../src/harness/workflows/resolve.js";

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

describe("resolveEntityRef — includeArchived (destructive/archive verbs, live item 305)", () => {
  const items = [
    { id: "p1", name: "Website Redesign" },
    { id: "p3", name: "Old Site", archived: true },
  ];
  const list = async () => items;

  it("resolves an ARCHIVED entity by name (deleting/unarchiving an archived entity is valid)", async () => {
    const result = await resolveEntityRef(
      { name: "Old Site" },
      { noun: "project", verb: "delete", list, includeArchived: true },
    );
    expect(result).toMatchObject({ ok: true, id: "p3", name: "Old Site" });
  });

  it("fetches BOTH archived states explicitly — the real list adapters default to active-only", async () => {
    const filters: Array<{ archived?: boolean } | undefined> = [];
    const result = await resolveEntityRef(
      { name: "Old Site" },
      {
        noun: "project",
        verb: "delete",
        list: async (filter?: { archived?: boolean }) => {
          filters.push(filter);
          if (filter?.archived === true) return [{ id: "p3", name: "Old Site", archived: true }];
          return [{ id: "p1", name: "Website Redesign" }];
        },
        includeArchived: true,
      },
    );
    expect(result).toMatchObject({ ok: true, id: "p3" });
    expect(filters).toContainEqual({ archived: false });
    expect(filters).toContainEqual({ archived: true });
  });

  it("offers archived candidates as did-you-mean options, labeled '(archived)'", async () => {
    const result = await resolveEntityRef(
      { name: "Old Sight" },
      { noun: "project", verb: "delete", list, includeArchived: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.clarify.options?.map((o) => o.id)).toContain("p3");
      const archivedLabel = result.clarify.options?.find((o) => o.id === "p3")?.label;
      expect(archivedLabel).toBe("Old Site (archived)");
    }
  });

  it("labels archived duplicates in an ambiguity clarify so the admin can tell them apart", async () => {
    const dupes = [
      { id: "a", name: "Focus" },
      { id: "b", name: "Focus", archived: true },
    ];
    const result = await resolveEntityRef(
      { name: "Focus" },
      { noun: "tag", verb: "delete", list: async () => dupes, includeArchived: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.clarify.options?.map((o) => o.label)).toEqual(["Focus", "Focus (archived)"]);
    }
  });

  it("keeps EXCLUDING archived entities by default (create/normal-update resolution unchanged)", async () => {
    const result = await resolveEntityRef(
      { name: "Old Site" },
      { noun: "project", verb: "update", list },
    );
    expect(result.ok).toBe(false);
  });
});

describe("resolveUserRefs", () => {
  const users = [
    { id: HEX_ID, name: "Alice" },
    { id: "u2", name: "Bob" },
    { id: "u3", name: "Charlie" },
    { id: "u4", name: "Charlie" }, // duplicate name → ambiguous
  ];
  const opts = (listed: { n: number }) => ({
    verb: "assign",
    adminUserId: "admin-1",
    listUsers: async () => {
      listed.n += 1;
      return users;
    },
  });

  it("trusts a 24-hex id WITHOUT listing, maps 'me' to the admin, and resolves names", async () => {
    const listed = { n: 0 };
    const r = await resolveUserRefs([HEX_ID, "me", "Bob"], opts(listed));
    // HEX_ID + me need no list; "Bob" triggers exactly one list call.
    expect(listed.n).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userIds).toEqual([HEX_ID, "admin-1", "u2"]);
  });

  it("resolves short (test-style) ids via the listed users before treating them as names", async () => {
    const r = await resolveUserRefs(["u2"], opts({ n: 0 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userIds).toEqual(["u2"]);
  });

  it("collapses duplicates and ignores blanks", async () => {
    const r = await resolveUserRefs(["me", "me", "  ", "Alice"], opts({ n: 0 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userIds).toEqual(["admin-1", HEX_ID]);
  });

  it("clarifies (does not guess) on an ambiguous name", async () => {
    const r = await resolveUserRefs(["Charlie"], opts({ n: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.clarify.options?.map((o) => o.id)).toEqual(["u3", "u4"]);
  });

  it("clarifies with grounded options on an unknown name", async () => {
    const r = await resolveUserRefs(["Nobody"], opts({ n: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.clarify.clarify).toContain("isn't a workspace member");
  });
});
