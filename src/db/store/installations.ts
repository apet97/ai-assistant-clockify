import type {
  EraseCounts,
  Installation,
  InstallationEnv,
  InstallationInput,
  InstallationStatus,
  StoreContext,
} from "./context.js";
import { canonicalClockifyServiceUrl } from "../../clockify/service-url.js";

function optionalServiceUrl(value: string | undefined, service: "api" | "reports"): string | undefined {
  return value === undefined ? undefined : canonicalClockifyServiceUrl(value, service);
}

interface InstallationRow {
  workspace_id: string;
  addon_id: string;
  addon_user_id: string;
  addon_token_ciphertext: string;
  api_url: string | null;
  backend_url: string | null;
  reports_url: string | null;
  status: InstallationStatus;
  installed_by_user_id: string | null;
  installed_at: string;
  updated_at: string;
}

/**
 * Installation concern: the per-workspace install row + token crypto at rest
 * (sealToken/openToken come from the shared context) and the GDPR/uninstall
 * workspace erase.
 */
export function buildInstallationStore(ctx: StoreContext): {
  saveInstallation(input: InstallationInput): void;
  getInstallation(workspaceId: string): Installation | undefined;
  updateInstallationEnv(workspaceId: string, env: InstallationEnv): void;
  setInstallationStatus(workspaceId: string, status: InstallationStatus): void;
  eraseWorkspace(workspaceId: string): EraseCounts;
} {
  const { db, nowIso, sealToken, openToken } = ctx;
  return {
    saveInstallation(input) {
      const timestamp = nowIso();
      const apiUrl = optionalServiceUrl(input.apiUrl, "api");
      const backendUrl = optionalServiceUrl(input.backendUrl, "api");
      const reportsUrl = optionalServiceUrl(input.reportsUrl, "reports");
      db.prepare(
        `INSERT INTO installations (
           workspace_id, addon_id, addon_user_id, addon_token_ciphertext,
           api_url, backend_url, reports_url, status, installed_by_user_id, installed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           addon_id = excluded.addon_id,
           addon_user_id = excluded.addon_user_id,
           addon_token_ciphertext = excluded.addon_token_ciphertext,
           api_url = excluded.api_url,
           backend_url = excluded.backend_url,
           reports_url = COALESCE(excluded.reports_url, installations.reports_url),
           status = excluded.status,
           installed_by_user_id = excluded.installed_by_user_id,
           updated_at = excluded.updated_at`,
      ).run(
        input.workspaceId,
        input.addonId,
        input.addonUserId,
        sealToken(input.addonToken),
        apiUrl ?? null,
        backendUrl ?? null,
        reportsUrl ?? null,
        input.status ?? "active",
        input.installedByUserId ?? null,
        timestamp,
        timestamp,
      );
    },

    updateInstallationEnv(workspaceId, env) {
      const apiUrl = optionalServiceUrl(env.apiUrl, "api");
      const backendUrl = optionalServiceUrl(env.backendUrl, "api");
      const reportsUrl = optionalServiceUrl(env.reportsUrl, "reports");
      db.prepare(
        `UPDATE installations SET
           api_url = COALESCE(?, api_url),
           backend_url = COALESCE(?, backend_url),
           reports_url = COALESCE(?, reports_url),
           updated_at = ?
         WHERE workspace_id = ?`,
      ).run(
        apiUrl ?? null,
        backendUrl ?? null,
        reportsUrl ?? null,
        nowIso(),
        workspaceId,
      );
    },

    getInstallation(workspaceId) {
      const row = db
        .prepare("SELECT * FROM installations WHERE workspace_id = ?")
        .get(workspaceId) as InstallationRow | undefined;
      if (!row) return undefined;
      return {
        workspaceId: row.workspace_id,
        addonId: row.addon_id,
        addonUserId: row.addon_user_id,
        addonToken: openToken(row.addon_token_ciphertext),
        apiUrl: row.api_url ?? undefined,
        backendUrl: row.backend_url ?? undefined,
        reportsUrl: row.reports_url ?? undefined,
        status: row.status,
        installedByUserId: row.installed_by_user_id ?? undefined,
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
      };
    },

    setInstallationStatus(workspaceId, status) {
      db.prepare("UPDATE installations SET status = ?, updated_at = ? WHERE workspace_id = ?").run(
        status,
        nowIso(),
        workspaceId,
      );
    },

    eraseWorkspace(workspaceId) {
      const del = (sql: string): number => db.prepare(sql).run(workspaceId).changes;
      const run = db.transaction((): EraseCounts => {
        // FK-children of chat_sessions (chat_messages, pending_confirmations) MUST
        // be deleted before chat_sessions (foreign_keys = ON). undo_records and
        // turn_telemetry carry session_id but no FK; admin_policies is independent.
        const intentCapabilityUsage = del(
          "DELETE FROM intent_capability_usage WHERE capability_id IN (SELECT id FROM intent_capabilities WHERE workspace_id = ?)",
        );
        const operationSteps = del(
          "DELETE FROM operation_steps WHERE operation_id IN (SELECT id FROM operation_runs WHERE workspace_id = ?)",
        );
        const chatMessageResultLinks = del(
          "DELETE FROM chat_message_result_links WHERE message_id IN (SELECT id FROM chat_messages WHERE workspace_id = ?)",
        );
        const turnRunResultLinks = del(
          "DELETE FROM turn_run_result_links WHERE session_id IN (SELECT session_id FROM turn_runs WHERE workspace_id = ?)",
        );
        const chatMessages = del("DELETE FROM chat_messages WHERE workspace_id = ?");
        const pendingConfirmations = del("DELETE FROM pending_confirmations WHERE workspace_id = ?");
        const auditEvents = del("DELETE FROM audit_events WHERE workspace_id = ?");
        const undoRecords = del("DELETE FROM undo_records WHERE workspace_id = ?");
        const turnTelemetry = del("DELETE FROM turn_telemetry WHERE workspace_id = ?");
        const turnRuns = del("DELETE FROM turn_runs WHERE workspace_id = ?");
        const operationRuns = del("DELETE FROM operation_runs WHERE workspace_id = ?");
        const intentCapabilities = del("DELETE FROM intent_capabilities WHERE workspace_id = ?");
        const actionResults = del("DELETE FROM action_results WHERE workspace_id = ?");
        const artifacts = del("DELETE FROM artifacts WHERE workspace_id = ?");
        const idempotencyKeys = del("DELETE FROM idempotency_keys WHERE workspace_id = ?");
        const adminPolicies = del("DELETE FROM admin_policies WHERE workspace_id = ?");
        const chatSessions = del("DELETE FROM chat_sessions WHERE workspace_id = ?");
        const installations = del("DELETE FROM installations WHERE workspace_id = ?");
        return {
          installations,
          adminPolicies,
          chatSessions,
          chatMessages,
          pendingConfirmations,
          auditEvents,
          undoRecords,
          turnTelemetry,
          turnRuns,
          operationSteps,
          operationRuns,
          intentCapabilityUsage,
          intentCapabilities,
          actionResults,
          artifacts,
          idempotencyKeys,
          turnRunResultLinks,
          chatMessageResultLinks,
        };
      });
      return run();
    },
  };
}
