import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { FakeContext } from "./state.js";

export function makeFakeReports({ bump }: FakeContext): Pick<
  WorkspaceClient,
  "summaryReport" | "detailedReport" | "weeklyReport"
> {
  return {
    async summaryReport(range, groups) {
      bump("summaryReport");
      return { type: "summary", range, groups: groups ?? ["PROJECT"], totals: [] };
    },
    async detailedReport(range) {
      bump("detailedReport");
      return { type: "detailed", range, timeentries: [] };
    },
    async weeklyReport(range) {
      bump("weeklyReport");
      return { type: "weekly", range };
    },
  };
}
