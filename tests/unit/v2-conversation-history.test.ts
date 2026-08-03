import { describe, expect, it } from "vitest";
import { createRunService } from "../../src/services/run-service.js";

/**
 * v2 shipped with NO conversation history.
 *
 * `buildFreshMessages` returned exactly `[system, currentRequest]`, so every
 * message the admin sent started a run that knew nothing about any previous
 * turn. v1 carried a 12-message window (`HISTORY_WINDOW_MESSAGES`); v2 carried
 * none.
 *
 * Observed 2026-08-03 on ede5896, in a single conversation:
 *   admin: "ALL ENTRIES FOR THIS YEAR"     -> assistant lists exactly one entry,
 *                                             quotes its id and project
 *   admin: "UPDATE THE DESCRIPTION TO 'DESC'"
 *          -> "doesn't specify which entity ... could be a time entry, a
 *              project, a task, a client, a tag"
 *   admin: "both.."
 *          -> "Could you clarify what you'd like me to do? ... View or manage
 *              time entries? Work with projects, tasks, or clients?"
 *
 * Neither reply is a model failure: the model was never shown the turn it was
 * being asked to continue. A chat product cannot answer "both" without the
 * message that offered two options.
 */

const STATE = {
  runId: "run-1",
  sessionId: "s1",
  workspaceId: "ws-1",
  adminUserId: "admin-1",
  installationGeneration: 1,
  authClass: "addon" as const,
  originalRequest: "both..",
  completedResults: [],
} as never;

function service(history?: Array<{ role: "user" | "assistant"; content: string }>) {
  return createRunService({
    modelClient: {} as never,
    eventService: {} as never,
    runStore: {} as never,
    clock: { now: () => new Date("2026-08-03T00:00:00Z"), monotonicMs: () => 0 },
    ...(history ? { priorMessages: history } : {}),
  } as never);
}

describe("a v2 turn can see the conversation it is continuing", () => {
  it("places prior turns between the system prompt and the current request", () => {
    const messages = service([
      { role: "user", content: "ALL ENTRIES FOR THIS YEAR" },
      { role: "assistant", content: "There is one entry, id 6a6fdef34135cca0c943b998." },
    ]).buildFreshMessages(STATE);

    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1]!.content).toBe("ALL ENTRIES FOR THIS YEAR");
    expect(messages[2]!.content).toContain("6a6fdef34135cca0c943b998");
    // The current request stays LAST, so it is what the model is answering.
    expect(messages[messages.length - 1]!.content).toBe("both..");
  });

  it("is unchanged when there is no history — the first turn of a session", () => {
    const messages = service().buildFreshMessages(STATE);
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1]!.content).toBe("both..");
  });

  it("keeps history ahead of a resume's structured summaries", () => {
    const messages = service([
      { role: "user", content: "list my entries" },
    ]).buildFreshMessages(STATE, ["clockify_entries_list returned: 1 entry"], "update it");

    expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(messages[1]!.content).toBe("list my entries");
    expect(messages[2]!.content).toContain("clockify_entries_list returned: 1 entry");
    expect(messages[2]!.content).toContain("update it");
  });
});
