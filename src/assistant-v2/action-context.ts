import type { ActionContext } from "../harness/action.js";
import type { AdminPolicy } from "../harness/permissions.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { RunScope } from "./protocol.js";

/** Shared ActionContext assembly for v2 read execution and write preparation. */
export async function buildV2ActionContext(input: {
  scope: RunScope;
  policy: AdminPolicy;
  clockify: WorkspaceClient;
  now?: () => Date;
  loadCalendarContext?: (scope: RunScope) => Promise<{
    timeZone?: string;
    weekStartsOn?: number;
  }>;
  saveArtifact?: ActionContext["saveArtifact"];
}): Promise<ActionContext> {
  const calendar = await input.loadCalendarContext?.(input.scope);
  return {
    workspaceId: input.scope.workspaceId,
    adminUserId: input.scope.adminUserId,
    policy: input.policy,
    clockify: input.clockify,
    now: input.now ?? (() => new Date()),
    ...(calendar?.timeZone ? { timeZone: calendar.timeZone } : {}),
    ...(calendar?.weekStartsOn !== undefined ? { weekStartsOn: calendar.weekStartsOn } : {}),
    ...(input.saveArtifact ? { saveArtifact: input.saveArtifact } : {}),
  };
}
