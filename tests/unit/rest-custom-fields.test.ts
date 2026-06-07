import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeCustomFieldRest } from "../../src/clockify/rest/custom-fields.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const rest = (fetchImpl: typeof fetch) =>
  makeCustomFieldRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("custom field rest", () => {
  it("listCustomFields paginates the bare array and maps type/status/required/allowedValues", async () => {
    const f = vi.fn(async () =>
      jsonResponse([{ id: "cf1", name: "Priority", type: "DROPDOWN_SINGLE", status: "VISIBLE", required: true, allowedValues: ["Hi", "Lo"] }]),
    );
    const out = await rest(f as unknown as typeof fetch).listCustomFields();
    expect(out).toEqual([
      { id: "cf1", name: "Priority", type: "DROPDOWN_SINGLE", status: "VISIBLE", required: true, allowedValues: ["Hi", "Lo"] },
    ]);
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/custom-fields");
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("getCustomField finds the field in the LIST (single GET /custom-fields/{id} 405s)", async () => {
    const hit = vi.fn(async () =>
      jsonResponse([{ id: "cf1", name: "Priority", type: "TXT" }, { id: "cf2", name: "X", type: "NUMBER" }]),
    );
    expect(await rest(hit as unknown as typeof fetch).getCustomField("cf1")).toEqual({
      id: "cf1",
      name: "Priority",
      type: "TXT",
    });
    // It must read the LIST path, not the 405 single-field path.
    expect(new URL((hit as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/custom-fields");
    const miss = vi.fn(async () => jsonResponse([{ id: "cfX", name: "Y" }]));
    expect(await rest(miss as unknown as typeof fetch).getCustomField("cf1")).toBeNull();
  });

  it("createCustomField POSTs name/type with status VISIBLE and dropdown allowedValues", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "cf9", name: "Priority" }));
    const cf = await rest(f as unknown as typeof fetch).createCustomField({
      name: "Priority",
      type: "DROPDOWN_SINGLE",
      allowedValues: ["Hi", "Lo"],
      required: true,
    });
    expect(cf).toEqual({ id: "cf9", name: "Priority" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/custom-fields");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "Priority",
      type: "DROPDOWN_SINGLE",
      status: "VISIBLE",
      allowedValues: ["Hi", "Lo"],
      required: true,
    });
  });

  it("updateCustomField finds the field in the LIST then PUTs, always carrying `type` (single GET 405s)", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse([{ id: "cf1", name: "Old", type: "DROPDOWN_SINGLE", status: "VISIBLE", required: false, allowedValues: ["A", "B"] }])
        : jsonResponse({ id: "cf1", name: "New" }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateCustomField("cf1", { name: "New" });
    expect(updated).toEqual({ id: "cf1", name: "New" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    // the GET reads the LIST; the PUT targets the field
    expect(new URL(calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/custom-fields");
    expect(calls[1][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/custom-fields/cf1");
    const body = JSON.parse(calls[1][1].body);
    expect(body.name).toBe("New");
    expect(body.type).toBe("DROPDOWN_SINGLE"); // sourced from existing — Clockify requires it
    expect(body.allowedValues).toEqual(["A", "B"]); // preserved
  });

  it("deleteCustomField issues a DELETE", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteCustomField("cf1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/custom-fields/cf1");
    expect(init.method).toBe("DELETE");
  });

  it("setProjectCustomFieldValue PATCHes the project custom-field route with defaultValue", async () => {
    const f = vi.fn(async () => jsonResponse({}));
    await rest(f as unknown as typeof fetch).setProjectCustomFieldValue("p1", "cf1", "High");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1/custom-fields/cf1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ defaultValue: "High" });
  });

  it("setEntryCustomFieldValue GETs the entry, merges customFieldValues, and PUTs the full entry with start", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({
            id: "e1",
            description: "work",
            projectId: "p1",
            billable: true,
            timeInterval: { start: "2026-06-06T10:00:00Z", end: "2026-06-06T11:00:00Z" },
            customFieldValues: [{ customFieldId: "cf0", value: "keep" }],
          })
        : jsonResponse({ id: "e1" }),
    );
    await rest(f as unknown as typeof fetch).setEntryCustomFieldValue("e1", "cf1", "new");
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    expect(calls[1][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-entries/e1");
    const body = JSON.parse(calls[1][1].body);
    expect(body.start).toBe("2026-06-06T10:00:00Z"); // flattened from timeInterval (PUT requires it)
    expect(body.customFieldValues).toEqual([
      { customFieldId: "cf0", value: "keep" }, // preserved
      { customFieldId: "cf1", value: "new" }, // appended
    ]);
  });

  it("setEntryCustomFieldValue replaces an existing value for the same field id", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({
            id: "e1",
            timeInterval: { start: "2026-06-06T10:00:00Z" },
            customFieldValues: [{ customFieldId: "cf1", value: "old" }],
          })
        : jsonResponse({ id: "e1" }),
    );
    await rest(f as unknown as typeof fetch).setEntryCustomFieldValue("e1", "cf1", "updated");
    const body = JSON.parse((f as any).mock.calls[1][1].body);
    expect(body.customFieldValues).toEqual([{ customFieldId: "cf1", value: "updated" }]);
  });
});
