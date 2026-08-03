import { describe, expect, it } from "vitest";
import { executeReadsConcurrently } from "../../src/services/action-execution-service.js";
import { InstallationChangedError } from "../../src/assistant-v2/terminal-reason.js";
import type { ReadExecutionOutcome, RunScope } from "../../src/assistant-v2/protocol.js";
import type { ToolCall } from "../../src/assistant/model-client.js";

/**
 * T12: `requestGovernorFor` (src/routes/v2-chat-pipeline.ts) denies a read
 * mid-run by throwing when the installation generation no longer matches.
 * `executeReadsConcurrently` catches that throw and must still surface the
 * public terminal reason `installation_changed` — the exact admin-facing
 * behaviour pinned here — regardless of whether the throw is the legacy bare
 * `Error("installation_changed")` or the typed `InstallationChangedError`.
 *
 * This is a characterization test: it passed before the typed class existed
 * (via the generic `asTerminalReason(error.message)` string recognizer) and
 * must keep passing now that the consumer also checks `instanceof`.
 */
describe("executeReadsConcurrently — installation_changed denial", () => {
  const scope: RunScope & { runId: string } = {
    sessionId: "s1",
    runId: "r1",
    workspaceId: "w1",
    adminUserId: "a1",
    installationGeneration: 1,
    authClass: "addon",
  };
  const call: ToolCall = { id: "tc-1", name: "clockify_tags_list", arguments: {} };

  it("surfaces installation_changed for the legacy bare Error (today's producer)", async () => {
    const results: Array<{ call: ToolCall; outcome: ReadExecutionOutcome }> = [];
    await executeReadsConcurrently(
      [call],
      scope,
      {
        requestGovernor: {
          runRead: async () => {
            throw new Error("installation_changed");
          },
        },
        reads: { execute: async () => ({ kind: "denied", code: "unexpected" }) },
      },
      undefined,
      (c, outcome) => results.push({ call: c, outcome }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toEqual({ kind: "denied", code: "installation_changed" });
  });

  it("surfaces installation_changed for the typed InstallationChangedError", async () => {
    const results: Array<{ call: ToolCall; outcome: ReadExecutionOutcome }> = [];
    await executeReadsConcurrently(
      [call],
      scope,
      {
        requestGovernor: {
          runRead: async () => {
            throw new InstallationChangedError();
          },
        },
        reads: { execute: async () => ({ kind: "denied", code: "unexpected" }) },
      },
      undefined,
      (c, outcome) => results.push({ call: c, outcome }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toEqual({ kind: "denied", code: "installation_changed" });
  });
});
