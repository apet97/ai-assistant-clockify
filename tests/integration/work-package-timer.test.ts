import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createRestWorkspaceClient } from "../../src/clockify/rest-workspace.js";
import type { ActionContext } from "../../src/harness/action.js";

/**
 * Wire-level proof for the "create a project AND start a timer on it" one-turn
 * fix: the combined `clockify_create_work_package` action resolves the new
 * project id server-side and the start-timer request carries it. Uses the real
 * REST adapter over a mocked fetch so the request shape is pinned at the wire.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("create_work_package + startTimer (wire shape)", () => {
  it("the start-timer POST carries the just-created project's id", async () => {
    const timerBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method === "GET" && url.includes("/projects?")) {
        return jsonResponse([]); // no existing "Apollo" project -> create it
      }
      if (method === "POST" && url.endsWith("/projects")) {
        return jsonResponse({ id: "p-new", name: "Apollo" });
      }
      if (method === "POST" && url.endsWith("/time-entries")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        timerBodies.push(body);
        return jsonResponse({ id: "e-new", projectId: body.projectId, timeInterval: { start: body.start } });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    const clockify = createRestWorkspaceClient({
      baseUrl: "https://api.clockify.me/api/v1",
      workspaceId: "ws-1",
      auth: { apiKey: "k" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const context: ActionContext = {
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      policy: defaultAdminPolicy(),
      clockify,
      now: () => new Date("2026-06-08T00:00:00.000Z"),
    };

    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Apollo" }, startTimer: { description: "kickoff" } },
      context,
    });

    expect(result.kind).toBe("receipt");
    expect(result.kind === "receipt" && result.receipt.ok).toBe(true);
    expect(timerBodies).toHaveLength(1);
    expect(timerBodies[0].projectId).toBe("p-new");
    expect(timerBodies[0].description).toBe("kickoff");
  });
});
