import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeTagRest } from "../../src/clockify/rest/tags.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const rest = (fetchImpl: typeof fetch) =>
  makeTagRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("tag rest", () => {
  it("listTags paginates with archived=false default and passes name filter", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "t1", name: "Deep Work" }]));
    const tags = await rest(f as unknown as typeof fetch).listTags({ name: "Deep" });
    expect(tags).toEqual({ rows: [{ id: "t1", name: "Deep Work", archived: undefined }], truncated: false });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/tags");
    expect(parsed.searchParams.get("archived")).toBe("false");
    expect(parsed.searchParams.get("name")).toBe("Deep");
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("getTag fetches one, or null on 404", async () => {
    const hit = vi.fn(async () => jsonResponse({ id: "t1", name: "Deep Work" }));
    expect(await rest(hit as unknown as typeof fetch).getTag("t1")).toEqual({
      id: "t1",
      name: "Deep Work",
      archived: undefined,
    });
    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getTag("tX")).toBeNull();
  });

  it("createTag POSTs the name", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "t9", name: "Focus" }));
    const t = await rest(f as unknown as typeof fetch).createTag({ name: "Focus" });
    expect(t).toEqual({ id: "t9", name: "Focus", archived: undefined });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/tags");
    expect(JSON.parse(init.body)).toEqual({ name: "Focus" });
  });

  it("updateTag GET-then-merge-PUTs (preserves fields, requires name)", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "t1", name: "Old", archived: false })
        : jsonResponse({ id: "t1", name: "New", archived: false }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateTag("t1", { name: "New" });
    expect(updated).toEqual({ id: "t1", name: "New", archived: false });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(calls[1][1].body).name).toBe("New");
  });

  it("deleteTag issues a single bare DELETE", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteTag("t1");
    expect((f as any).mock.calls.map((c: any) => c[1].method)).toEqual(["DELETE"]);
    expect((f as any).mock.calls[0][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/tags/t1");
  });
});
