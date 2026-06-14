import { describe, expect, it } from "vitest";
import { ApiError, SESSION_EXPIRED_MESSAGE, switchToSession, type ChatApi } from "../../src/ui/main.js";

/**
 * The chat-history switch flow (Phase 6 wiring core): selecting a past
 * conversation calls `api.switchSession(id)`; ON SUCCESS the host resets the
 * transcript + replays the switched-to session (fired via `onSwitched`); ON
 * FAILURE it surfaces an honest error and KEEPS the current chat intact
 * (`onSwitched` is NEVER called — the cookie was not re-bound, so the visible
 * transcript must not be torn down). A 401 maps to the session-expired copy
 * (reload), mirroring the rest of the UI's error discipline.
 */
function recordingApi(impl: () => Promise<unknown>): ChatApi {
  const stub = async (): Promise<unknown> => ({ ok: true });
  return {
    getPermissions: stub,
    savePermissions: stub,
    getHistory: stub,
    newChat: stub,
    listSessions: stub,
    switchSession: impl,
    sendMessage: stub,
    streamMessage: async () => {},
    confirmPreview: stub,
    confirmStream: async () => {},
    cancelPreview: stub,
    undo: stub,
  };
}

describe("switchToSession", () => {
  it("on success resets+replays via onSwitched and clears any error", async () => {
    let switched = 0;
    let switchedId = "";
    const errors: string[] = [];
    const api = recordingApi(async () => ({ ok: true }));
    await switchToSession(api, "sess-1", {
      onSwitched: (id) => {
        switched += 1;
        switchedId = id;
      },
      onError: (m) => errors.push(m),
    });
    expect(switched).toBe(1);
    expect(switchedId).toBe("sess-1");
    expect(errors).toEqual([]);
  });

  it("on a thrown 401 shows the session-expired copy and NEVER switches", async () => {
    let switched = 0;
    const errors: string[] = [];
    const api = recordingApi(async () => {
      throw new ApiError(401, "No valid session.");
    });
    await switchToSession(api, "sess-1", {
      onSwitched: () => {
        switched += 1;
      },
      onError: (m) => errors.push(m),
    });
    expect(switched).toBe(0); // the current chat is kept intact
    expect(errors).toEqual([SESSION_EXPIRED_MESSAGE]);
  });

  it("on an {ok:false} body keeps the current chat and surfaces the route's honest copy", async () => {
    let switched = 0;
    const errors: string[] = [];
    const api = recordingApi(async () => ({ ok: false, code: "not_found", message: "Conversation not found." }));
    await switchToSession(api, "ghost", {
      onSwitched: () => {
        switched += 1;
      },
      onError: (m) => errors.push(m),
    });
    expect(switched).toBe(0);
    expect(errors).toEqual(["Conversation not found."]);
  });

  it("on a generic throw keeps the chat and shows a friendly fallback", async () => {
    let switched = 0;
    const errors: string[] = [];
    const api = recordingApi(async () => {
      throw new Error("boom");
    });
    await switchToSession(api, "sess-1", {
      onSwitched: () => {
        switched += 1;
      },
      onError: (m) => errors.push(m),
    });
    expect(switched).toBe(0);
    expect(errors).toEqual(["Could not open that conversation. Please try again."]);
  });
});
