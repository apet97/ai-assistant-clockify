import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { FakeContext } from "./state.js";

export function makeFakeAudit({ bump }: FakeContext): Pick<
  WorkspaceClient,
  "searchAuditLog" | "listEntityChanges"
> {
  return {
    async searchAuditLog(input) {
      bump("searchAuditLog");
      return [{ action: input.actions[0], start: input.start, end: input.end }];
    },
    async listEntityChanges(changeType) {
      bump("listEntityChanges");
      return [{ changeType }];
    },
  };
}
