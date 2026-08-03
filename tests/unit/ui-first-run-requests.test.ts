import { describe, expect, it } from "vitest";
import { loadInitialData } from "../../src/ui/main.js";
import type { PermissionsResponse, SessionsResponse } from "../../src/ui/protocol.js";
import type { HistoryResponse } from "../../src/ui/shared.js";

/**
 * T14: on a genuine FIRST RUN, `openPermissions(true, …)` is the only thing
 * that renders — history replay and the chat-history dropdown are never
 * reached (see `mount`'s `init`). Firing `getHistory`/`listSessions` before
 * the permissions gate resolves is pure waste: the responses are fetched then
 * discarded. `loadInitialData` must not start either request until it knows
 * the admin is NOT on a first run.
 */
function permissions(firstRun: boolean): PermissionsResponse {
  return { ok: true, firstRun, featureGroups: [], policy: { version: 1, groups: {} } };
}

function history(): HistoryResponse & { ok: true } {
  return { ok: true, messages: [] };
}

function sessions(): SessionsResponse {
  return { ok: true, sessions: [] };
}

describe("loadInitialData (T14: defer history/session-list past the first-run gate)", () => {
  it("on first run, never calls getHistory or listSessions", async () => {
    const calls: string[] = [];
    const api = {
      getPermissions: async () => {
        calls.push("getPermissions");
        return permissions(true);
      },
      getHistory: async () => {
        calls.push("getHistory");
        return history();
      },
      listSessions: async () => {
        calls.push("listSessions");
        return sessions();
      },
    };

    const result = await loadInitialData(api);

    expect(calls).toEqual(["getPermissions"]);
    expect(result.perms.firstRun).toBe(true);
    expect(result.historyRequest).toBeUndefined();
    expect(result.sessionsRequest).toBeUndefined();
  });

  it("on a returning user, starts getHistory and listSessions immediately (unchanged behavior)", async () => {
    const calls: string[] = [];
    const api = {
      getPermissions: async () => {
        calls.push("getPermissions");
        return permissions(false);
      },
      getHistory: async () => {
        calls.push("getHistory");
        return history();
      },
      listSessions: async () => {
        calls.push("listSessions");
        return sessions();
      },
    };

    const result = await loadInitialData(api);

    expect(calls).toEqual(["getPermissions", "getHistory", "listSessions"]);
    expect(result.perms.firstRun).toBe(false);
    await expect(result.historyRequest).resolves.toEqual(history());
    await expect(result.sessionsRequest).resolves.toEqual(sessions());
  });
});
