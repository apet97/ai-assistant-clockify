import type { WorkspaceClient } from "../../../src/clockify/client.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeAudit({ seed, bump }: FakeContext): Pick<
  WorkspaceClient,
  "searchAuditLog" | "listEntityChanges"
> {
  return {
    async searchAuditLog(input) {
      bump("searchAuditLog");
      return fakeListResult(seed, "searchAuditLog", [{ action: input.actions[0], start: input.start, end: input.end }]);
    },
    async listEntityChanges(changeType) {
      bump("listEntityChanges");
      return fakeListResult(seed, "listEntityChanges", [{ changeType }]);
    },
  };
}
