import { randomUUID } from "node:crypto";
import type { AppDeps } from "./deps.js";
import type { ChatPipeline, ChatTurnOutcome } from "./chat-pipeline.js";
import { createChatPipeline } from "./chat-pipeline.js";
import { runAssistantV2 } from "../assistant-v2/runner.js";
import { MODEL_API_ACTION_CATALOG } from "../harness/api-catalog.js";
import { assertNativeToolClient, type NativeToolModelClient } from "../assistant-v2/protocol.js";
import { runDiscoverySearch } from "../assistant-v2/discovery/api-search-tool.js";
import { createRunEventService } from "../services/run-event-service.js";
import { createRunEventViewService } from "../services/run-event-view-service.js";

/** V2 chat pipeline: native-tool runner only — never falls through to v1 planner. */
export function createV2RunnerPipeline(deps: AppDeps): ChatPipeline {
  const controlPlane = createChatPipeline(deps);
  const eventService = createRunEventService(deps.store);
  const eventViews = createRunEventViewService(deps.store, { sessionSecret: deps.config.sessionSecret, now: deps.now });
  return {
    ...controlPlane,
    runResume: async () => undefined,
    executeChatTurn: async (
      claims,
      installation,
      message,
      _onResult,
      _onStatus,
      signal,
      requestId,
    ): Promise<ChatTurnOutcome> => {
      try {
        assertNativeToolClient(deps.modelClient as NativeToolModelClient);
      } catch {
        return {
          ok: false,
          code: "model_unavailable",
          message: "Assistant engine v2 requires a native tool-calling model client.",
        };
      }
      const runId = requestId ?? randomUUID();
      const outcome = await runAssistantV2({
        runId,
        scope: {
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          installationGeneration: installation.generation,
          authClass: "addon",
        },
        originalRequest: message,
        signal,
      }, {
        modelClient: deps.modelClient as NativeToolModelClient,
        runStore: deps.store,
        eventStore: deps.store,
        eventService,
        eventViews,
        actionRegistry: MODEL_API_ACTION_CATALOG,
        discovery: {
          search: async (input, scope) => {
            if (!deps.apiOperationIndex) {
              return { kind: "notice", code: "no_available_operation_for_auth_class", authClass: scope.authClass };
            }
            return runDiscoverySearch(deps.apiOperationIndex, input, scope.authClass);
          },
        },
        reads: {
          execute: async () => ({
            kind: "failed",
            code: "read_port_not_ready",
            actionResultId: "read-not-ready",
          }),
        },
        preparations: {
          prepare: async () => ({
            kind: "not_ready",
            code: "write_port_not_ready",
            actionResultId: "write-not-ready",
          }),
        },
        installationGuard: {
          assertCurrent: () => {
            const current = deps.store.getInstallation(claims.workspaceId);
            if (!current || current.status !== "active" || current.generation !== installation.generation) {
              throw new Error("installation_not_current");
            }
          },
        },
        requestGovernor: {
          runRead: async (_scope, op) => op(),
          remainingHostCalls: () => 60,
          persistHostCallAllowance: () => undefined,
        },
        clock: { now: () => new Date(), monotonicMs: () => performance.now() },
      });

      if (outcome.kind === "completed") {
        return {
          ok: true,
          replyKind: "final",
          replyText: "Completed.",
          results: [],
          resultLinks: [],
        };
      }
      if (outcome.kind === "suspended") {
        return {
          ok: true,
          replyKind: "preview",
          replyText: outcome.reason === "awaiting_confirmation"
            ? "Review the preview and click Confirm."
            : "Choose a clarification option to continue.",
          results: [],
          resultLinks: [],
        };
      }
      return {
        ok: false,
        code: outcome.code,
        message: `Assistant run failed: ${outcome.code}`,
      };
    },
  };
}
