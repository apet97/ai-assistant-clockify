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
      try {
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
      } catch (error) {
        if (error instanceof Error && error.message === "run_not_found") {
          throw error;
        }
        throw error;
      }
    },
  };
}

export type RunEventViewService = RunEventViewPort;

export { hydrateRunEventAttachments } from "./run-event-hydration.js";
