import { describe, expect, it, vi } from "vitest";
import { createRestWorkspaceClient } from "../../src/clockify/rest-workspace.js";

/**
 * Pagination correctness (enterprise audit, HIGH): user/group/category/policy list
 * reads used a single un-paginated GET, so Clockify's default page-size=50 silently
 * truncated every workspace with >50 of those entities — name resolution then
 * REFUSED actions for members/groups/categories/policies that sorted onto page 2+.
 * These tests follow a full first page (200 rows) to a partial second page; the old
 * single-GET returns only 200 and never sends page-size, so they fail pre-fix.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function client(fetchImpl: typeof fetch) {
  return createRestWorkspaceClient({
    baseUrl: "https://api.clockify.me/api/v1",
    workspaceId: "ws-1",
    auth: { addonToken: "tok" },
    fetchImpl,
    testOnlyEnforceMutationScope: false,
  });
}
function fullPage(n: number, prefix: string): { id: string; name: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}` }));
}
/** Fake fetch that returns a body keyed on the `page` query param. */
function pagedFetch(body: (page: string) => unknown): typeof fetch {
  return vi.fn(async (url: string) => jsonResponse(body(new URL(url).searchParams.get("page") ?? "1"))) as unknown as typeof fetch;
}
function firstPageSize(fetchImpl: typeof fetch): string | null {
  return new URL((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]).searchParams.get("page-size");
}

describe("workspace list pagination (>50 rows must not truncate)", () => {
  it("paginates listUsers through page 2 with page-size=200 (the >50-member bug)", async () => {
    const f = pagedFetch((page) => (page === "1" ? fullPage(200, "u") : [{ id: "u200", name: "User 200" }]));
    const users = await client(f).listUsers();
    expect(users).toMatchObject({ truncated: false });
    expect(users.rows).toHaveLength(201);
    expect(firstPageSize(f)).toBe("200");
  });

  it("paginates listGroups through page 2", async () => {
    const f = pagedFetch((page) => (page === "1" ? fullPage(200, "g") : [{ id: "g200", name: "Group 200" }]));
    expect((await client(f).listGroups()).rows).toHaveLength(201);
    expect(firstPageSize(f)).toBe("200");
  });

  it("paginates listTimeOffPolicies through page 2", async () => {
    const f = pagedFetch((page) => (page === "1" ? fullPage(200, "pol") : [{ id: "pol200", name: "Policy 200" }]));
    expect((await client(f).listTimeOffPolicies()).rows).toHaveLength(201);
    expect(firstPageSize(f)).toBe("200");
  });

  it("paginates listExpenseCategories through page 2 (envelope-unwrapped)", async () => {
    const f = pagedFetch((page) =>
      page === "1" ? { categories: fullPage(200, "cat") } : { categories: [{ id: "cat200", name: "Cat 200" }] },
    );
    expect((await client(f).listExpenseCategories()).rows).toHaveLength(201);
    expect(firstPageSize(f)).toBe("200");
  });
});
