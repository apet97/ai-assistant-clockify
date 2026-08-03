import type {
  ListRunEventsInput,
  RunEventPage,
  RunEventViewPort,
} from "../assistant-v2/events.js";
import type { Store } from "../db/store.js";
import type { AssistantRunScope } from "../db/store/runs.js";
import { hydrateRunEventAttachments } from "./run-event-hydration.js";

export interface RunEventViewServiceOptions {
  sessionSecret: string;
  now?: () => Date;
}

export function createRunEventViewService(
  store: Store,
  options?: RunEventViewServiceOptions,
): RunEventViewPort {
  const now = options?.now ?? (() => new Date());
  const sessionSecret = options?.sessionSecret ?? "";

  return {
    list(input: ListRunEventsInput): RunEventPage {
      const scope: AssistantRunScope = {
        sessionId: input.scope.sessionId,
        runId: input.runId,
        workspaceId: input.scope.workspaceId,
        adminUserId: input.scope.adminUserId,
        installationGeneration: input.scope.installationGeneration,
        authClass: input.scope.authClass,
      };
      // No try/catch: the only handler here caught every error and rethrew it
      // unchanged (including an explicit `run_not_found` branch that also just
      // rethrew), so it changed nothing and only implied a policy that did not
      // exist. Errors propagate to the route, exactly as they did before.
      const page = store.listRunEvents({ scope, after: input.after, limit: input.limit });
      const events = sessionSecret
        ? hydrateRunEventAttachments({
            store,
            scope,
            sessionSecret,
            now: now(),
          }, page.events)
        : page.events;
      return { ...page, events };
    },
  };
}

export type RunEventViewService = RunEventViewPort;

export { hydrateRunEventAttachments } from "./run-event-hydration.js";
