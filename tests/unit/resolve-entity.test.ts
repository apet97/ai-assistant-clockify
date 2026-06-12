import { describe, expect, it } from "vitest";
import {
  looksLikeClockifyId,
  resolveEntityRef,
  resolveGroupRefs,
  resolveProjectTaskRefs,
  resolveTagRefs,
  resolveUserRef,
  resolveUserRefs,
} from "../../src/harness/workflows/resolve.js";

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

describe("resolveEntityRef — notFoundHint", () => {
  const items = [{ id: "p1", name: "Website Redesign" }];
  const list = async () => items;

  it("appends the hint to the did-you-mean clarify (options exist)", async () => {
    const result = await resolveEntityRef(
      { name: "Webside" },
      { noun: "project", verb: "update", list, notFoundHint: "Or should I create it first?" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.clarify.clarify).toContain("Did you mean one of these?");
      expect(result.clarify.clarify).toContain("Or should I create it first?");
    }
  });

  it("appends the hint to the no-options clarify too", async () => {
    const result = await resolveEntityRef(
      { name: "Ghost" },
      { noun: "client", verb: "invoice", list: async () => [], notFoundHint: "Or should I create the client first?" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.clarify.clarify).toContain('There is no active client named "Ghost" to invoice.');
      expect(result.clarify.clarify).toContain("Or should I create the client first?");
    }
  });

  it("leaves the copy byte-identical when no hint is given", async () => {
    const result = await resolveEntityRef({ name: "Ghost" }, { noun: "client", verb: "invoice", list: async () => [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.clarify.clarify).toBe('There is no active client named "Ghost" to invoice.');
    }
  });
});

describe("resolveProjectTaskRefs", () => {
  const projects = [
    { id: "p1", name: "Website Redesign" },
    { id: "p2", name: "Mobile App" },
  ];
  const tasksByProject: Record<string, Array<{ id: string; name: string }>> = {
    p1: [
      { id: "t1", name: "Design" },
      { id: "t2", name: "Review" },
      { id: "t3", name: "Review" }, // duplicate name → ambiguous
    ],
  };
  const makeOpts = (counts: { projects: number; tasks: number }) => ({
    verb: "log against",
    listProjects: async () => {
      counts.projects += 1;
      return projects;
    },
    listTasks: async (projectId: string) => {
      counts.tasks += 1;
      return tasksByProject[projectId] ?? [];
    },
  });

  it("passes through untouched (zero list calls) when no refs are given", async () => {
    const counts = { projects: 0, tasks: 0 };
    const r = await resolveProjectTaskRefs({}, makeOpts(counts));
    expect(r).toEqual({ ok: true, projectId: undefined, projectName: undefined, taskId: undefined, taskName: undefined });
    expect(counts).toEqual({ projects: 0, tasks: 0 });
  });

  it("trusts 24-hex project and task ids with ZERO list calls (happy path unchanged)", async () => {
    const counts = { projects: 0, tasks: 0 };
    const TASK_HEX = "6a1b2c3d4e5f60718293a4b5";
    const r = await resolveProjectTaskRefs({ projectId: HEX_ID, taskId: TASK_HEX }, makeOpts(counts));
    expect(r).toMatchObject({ ok: true, projectId: HEX_ID, taskId: TASK_HEX });
    expect(counts).toEqual({ projects: 0, tasks: 0 });
  });

  it("resolves a NAME in the projectId slot (the planner habit) and returns the resolved name", async () => {
    const r = await resolveProjectTaskRefs({ projectId: "Mobile App" }, makeOpts({ projects: 0, tasks: 0 }));
    expect(r).toMatchObject({ ok: true, projectId: "p2", projectName: "Mobile App" });
  });

  it("resolves projectName and a task NAME in the taskId slot together", async () => {
    const r = await resolveProjectTaskRefs(
      { projectName: "Website Redesign", taskId: "Design" },
      makeOpts({ projects: 0, tasks: 0 }),
    );
    expect(r).toMatchObject({ ok: true, projectId: "p1", taskId: "t1", taskName: "Design" });
  });

  it("resolves taskName via listTasks(resolved project)", async () => {
    const counts = { projects: 0, tasks: 0 };
    const r = await resolveProjectTaskRefs({ projectId: "p1", taskName: "Design" }, makeOpts(counts));
    expect(r).toMatchObject({ ok: true, projectId: "p1", taskId: "t1", taskName: "Design" });
    expect(counts.tasks).toBe(1);
  });

  it("clarifies when a task name is given without any project", async () => {
    const r = await resolveProjectTaskRefs({ taskName: "Design" }, makeOpts({ projects: 0, tasks: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.clarify.clarify).toBe('To log against task "Design" I need the project. Which project is it in?');
    }
  });

  it("clarifies (never picks) on an ambiguous task name, with grounded options", async () => {
    const r = await resolveProjectTaskRefs({ projectId: "p1", taskName: "Review" }, makeOpts({ projects: 0, tasks: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.clarify.options?.map((o) => o.id)).toEqual(["t2", "t3"]);
  });

  it("clarifies on an unknown task name in the project", async () => {
    const r = await resolveProjectTaskRefs({ projectId: "p1", taskName: "Ghost" }, makeOpts({ projects: 0, tasks: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.clarify.clarify).toContain('"Ghost"');
  });

  it("clarifies on an unknown project name, carrying the projectNotFoundHint", async () => {
    const counts = { projects: 0, tasks: 0 };
    const r = await resolveProjectTaskRefs(
      { projectName: "Webside" },
      { ...makeOpts(counts), projectNotFoundHint: "Or should I create it first?" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.clarify.clarify).toContain("Or should I create it first?");
      expect(r.clarify.options?.map((o) => o.id)).toContain("p1");
    }
  });

  it("trusts a 24-hex taskId even with no project ref (id already resolved)", async () => {
    const counts = { projects: 0, tasks: 0 };
    const TASK_HEX = "6a1b2c3d4e5f60718293a4b5";
    const r = await resolveProjectTaskRefs({ taskId: TASK_HEX }, makeOpts(counts));
    expect(r).toMatchObject({ ok: true, taskId: TASK_HEX });
    expect(counts).toEqual({ projects: 0, tasks: 0 });
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

describe("resolveTagRefs", () => {
  const tags = [
    { id: "t1", name: "Deep Work" },
    { id: "t2", name: "Review" },
    { id: "t3", name: "Review" }, // duplicate → ambiguous
  ];
  const opts = (listed: { n: number }) => ({
    verb: "tag the entry with",
    listTags: async () => {
      listed.n += 1;
      return tags;
    },
  });

  it("trusts a 24-hex id without listing and resolves names/short ids", async () => {
    const listed = { n: 0 };
    const r = await resolveTagRefs([HEX_ID, "Deep Work", "t2"], opts(listed));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tagIds).toEqual([HEX_ID, "t1", "t2"]);
    expect(listed.n).toBe(1); // one list serves both symbolic refs
  });

  it("clarifies (never guesses) on an ambiguous tag name with grounded options", async () => {
    const r = await resolveTagRefs(["Review"], opts({ n: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.clarify.options?.map((o) => o.id)).toEqual(["t2", "t3"]);
  });

  it("clarifies on an unknown tag name", async () => {
    const r = await resolveTagRefs(["Ghost"], opts({ n: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.clarify.clarify).toContain("isn't a workspace tag");
  });
});

describe("resolveUserRef — trustIds (read-filter happy path)", () => {
  const users = [
    { id: "u2", name: "Bob" },
    { id: "u3", name: "Ana" },
  ];
  const opts = (listed: { n: number }, trustIds?: boolean) => ({
    verb: "filter by",
    adminUserId: "admin-1",
    listUsers: async () => {
      listed.n += 1;
      return users;
    },
    trustIds,
  });

  it("trusts a 24-hex id WITHOUT a list call when trustIds is set", async () => {
    const listed = { n: 0 };
    const r = await resolveUserRef({ id: HEX_ID }, opts(listed, true));
    expect(r).toMatchObject({ ok: true, userId: HEX_ID });
    expect(listed.n).toBe(0);
  });

  it("still resolves 'me' and names (and clarifies on unknown) with trustIds set", async () => {
    const listed = { n: 0 };
    const me = await resolveUserRef({ id: "me" }, opts(listed, true));
    expect(me).toMatchObject({ ok: true, userId: "admin-1", label: "you" });
    expect(listed.n).toBe(0);

    const byName = await resolveUserRef({ id: "Ana" }, opts(listed, true));
    expect(byName).toMatchObject({ ok: true, userId: "u3", label: "Ana" });

    const unknown = await resolveUserRef({ id: "Ghost" }, opts(listed, true));
    expect(unknown.ok).toBe(false);
  });

  it("keeps VERIFYING a 24-hex id by default (permission-affecting writes unchanged)", async () => {
    const listed = { n: 0 };
    const r = await resolveUserRef({ id: HEX_ID }, opts(listed));
    expect(listed.n).toBe(1);
    expect(r.ok).toBe(false); // HEX_ID is not in the user list → clarify, not trust
  });
});

describe("resolveGroupRefs", () => {
  const groups = [
    { id: "g1", name: "Devs" },
    { id: "g2", name: "Ops" },
    { id: "g3", name: "Ops" }, // duplicate name → ambiguous
  ];
  const opts = (listed: { n: number }) => ({
    verb: "assign",
    listGroups: async () => {
      listed.n += 1;
      return groups;
    },
  });

  it("resolves group names + ids to ids with labels", async () => {
    const r = await resolveGroupRefs(["Devs", "g2"], opts({ n: 0 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.groupIds).toEqual(["g1", "g2"]);
      expect(r.labels).toEqual(["Devs", "Ops"]);
    }
  });

  it("verifies even a 24-hex value (no blind trust): an unknown id clarifies as a group", async () => {
    const listed = { n: 0 };
    const r = await resolveGroupRefs([HEX_ID], opts(listed));
    expect(listed.n).toBe(1); // it MUST list to verify
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.clarify.clarify).toContain("isn't a user group");
  });

  it("clarifies (does not guess) on an ambiguous group name", async () => {
    const r = await resolveGroupRefs(["Ops"], opts({ n: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.clarify.options?.map((o) => o.id)).toEqual(["g2", "g3"]);
  });

  it("collapses duplicates and ignores blanks", async () => {
    const r = await resolveGroupRefs(["Devs", "  ", "Devs", "g2"], opts({ n: 0 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.groupIds).toEqual(["g1", "g2"]);
  });
});
