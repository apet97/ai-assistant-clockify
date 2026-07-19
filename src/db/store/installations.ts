import type {
  EraseCounts,
  Installation,
  InstallationEnv,
  InstallationInput,
  InstallationSaveResult,
  InstallationStatus,
  InstallationStatusResult,
  LifecycleDeletionResult,
  StoreContext,
} from "./context.js";
import { canonicalClockifyServiceUrl } from "../../clockify/service-url.js";
import {
  hashInstallationToken,
  hashInstallationWorkspace,
  hashRetiredInstallationToken,
  type InstallationAttestationRecord,
} from "../../addon/install-attestation.js";
import { timingSafeEqual } from "node:crypto";
import {
  hashLifecycleWorkspace,
  lifecycleLineageExpiresAt,
  type LifecycleAuthorityState,
} from "../../addon/lifecycle-authority.js";

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
  generation: number;
  lifecycle_issued_at: number | null;
  deletion_started_at: string | null;
  installed_by_user_id: string | null;
  installed_at: string;
  updated_at: string;
}

interface InstallationAttestationRow {
  workspace_sha256: string;
  installation_generation: number;
  token_fingerprint_sha256: string;
  release_sha: string;
  release_build_hash: string;
  server_artifact_sha256: string;
  source_relationship: InstallationAttestationRecord["sourceRelationship"];
  source_binding_sha256: string | null;
  manifest_sha256: string;
  installed_at: string;
}

interface LifecycleAuthorityWatermarkRow {
  lifecycle_issued_at: number;
  authority_state: LifecycleAuthorityState;
  installation_generation: number;
  expires_at: string;
}

interface EffectiveLifecycleAuthority {
  lifecycleIssuedAt: number;
  authorityState: LifecycleAuthorityState;
  installationGeneration: number;
}

function lifecycleAuthorityRank(state: LifecycleAuthorityState): number {
  if (state === "deleted") return 2;
  if (state === "inactive") return 1;
  return 0;
}

function equalFingerprint(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Installation concern: the per-workspace install row + token crypto at rest
 * (sealToken/openToken come from the shared context) and the GDPR/uninstall
 * workspace erase.
 */
export function buildInstallationStore(ctx: StoreContext): {
  saveInstallation(input: InstallationInput): InstallationSaveResult;
  getInstallation(workspaceId: string): Installation | undefined;
  getAuthenticatedInstallationAttestation(
    workspaceId: string,
    addonToken: string,
  ): InstallationAttestationRecord | undefined;
  updateInstallationEnv(workspaceId: string, env: InstallationEnv): void;
  setInstallationStatus(
    workspaceId: string,
    status: InstallationStatus,
    lifecycleIssuedAt?: number,
  ): InstallationStatusResult;
  tombstoneInstallationForLifecycle(
    workspaceId: string,
    lifecycleIssuedAt: number,
  ): LifecycleDeletionResult;
  tombstoneInstallation(workspaceId: string): { generation: number } | undefined;
  listDeletionTombstones(): string[];
  eraseWorkspace(workspaceId: string): EraseCounts;
  eraseWorkspaceForDeletion(workspaceId: string, generation: number): EraseCounts | undefined;
} {
  const { db, now, nowIso, sealToken, openToken } = ctx;
  // Fast process-local generation cache. The privacy-bounded, domain-separated
  // lifecycle watermark below also carries the generation across restart for
  // the complete interval in which a signed callback can still be accepted.
  const lastGenerations = new Map<string, number>();
  const rememberGeneration = (workspaceId: string, generation: number): void => {
    lastGenerations.set(
      workspaceId,
      Math.max(generation, lastGenerations.get(workspaceId) ?? 0),
    );
  };

  const pruneLifecycleAuthority = (timestamp: string): void => {
    db.prepare("DELETE FROM lifecycle_authority_watermarks WHERE expires_at <= ?")
      .run(timestamp);
  };

  const lifecycleAuthority = (
    workspaceId: string,
    current: InstallationRow | undefined,
    timestamp: string,
  ): EffectiveLifecycleAuthority | undefined => {
    pruneLifecycleAuthority(timestamp);
    const row = db.prepare(
      `SELECT lifecycle_issued_at, authority_state, installation_generation, expires_at
         FROM lifecycle_authority_watermarks
        WHERE workspace_fingerprint_sha256 = ?`,
    ).get(hashLifecycleWorkspace(workspaceId)) as LifecycleAuthorityWatermarkRow | undefined;
    const persisted = row
      ? {
          lifecycleIssuedAt: row.lifecycle_issued_at,
          authorityState: row.authority_state,
          installationGeneration: row.installation_generation,
        }
      : undefined;
    if (current?.lifecycle_issued_at === null || current?.lifecycle_issued_at === undefined) {
      if (persisted) return persisted;
      if (!current) return undefined;
      const installedAt = Date.parse(current.installed_at);
      if (!Number.isFinite(installedAt)) return undefined;
      return {
        lifecycleIssuedAt: Math.max(0, Math.floor((installedAt - 30_000) / 1000)),
        authorityState: current.status,
        installationGeneration: current.generation,
      };
    }
    const fromInstallation: EffectiveLifecycleAuthority = {
      lifecycleIssuedAt: current.lifecycle_issued_at,
      authorityState: current.status,
      installationGeneration: current.generation,
    };
    if (!persisted || fromInstallation.lifecycleIssuedAt > persisted.lifecycleIssuedAt) {
      return fromInstallation;
    }
    if (fromInstallation.lifecycleIssuedAt < persisted.lifecycleIssuedAt) return persisted;
    const authorityState = lifecycleAuthorityRank(fromInstallation.authorityState)
      > lifecycleAuthorityRank(persisted.authorityState)
      ? fromInstallation.authorityState
      : persisted.authorityState;
    return {
      lifecycleIssuedAt: persisted.lifecycleIssuedAt,
      authorityState,
      installationGeneration: Math.max(
        persisted.installationGeneration,
        fromInstallation.installationGeneration,
      ),
    };
  };

  const recordLifecycleAuthority = (
    workspaceId: string,
    lifecycleIssuedAt: number,
    authorityState: LifecycleAuthorityState,
    installationGeneration: number,
    recordedAt: Date,
  ): void => {
    db.prepare(
      `INSERT INTO lifecycle_authority_watermarks (
         workspace_fingerprint_sha256, lifecycle_issued_at, authority_state,
         installation_generation, recorded_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_fingerprint_sha256) DO UPDATE SET
         lifecycle_issued_at = excluded.lifecycle_issued_at,
         authority_state = excluded.authority_state,
         installation_generation = MAX(
           lifecycle_authority_watermarks.installation_generation,
           excluded.installation_generation
         ),
         recorded_at = excluded.recorded_at,
         expires_at = excluded.expires_at
       WHERE excluded.lifecycle_issued_at > lifecycle_authority_watermarks.lifecycle_issued_at
          OR (
            excluded.lifecycle_issued_at = lifecycle_authority_watermarks.lifecycle_issued_at
            AND CASE excluded.authority_state
                  WHEN 'deleted' THEN 2
                  WHEN 'inactive' THEN 1
                  ELSE 0
                END >= CASE lifecycle_authority_watermarks.authority_state
                  WHEN 'deleted' THEN 2
                  WHEN 'inactive' THEN 1
                  ELSE 0
                END
          )`,
    ).run(
      hashLifecycleWorkspace(workspaceId),
      lifecycleIssuedAt,
      authorityState,
      installationGeneration,
      recordedAt.toISOString(),
      lifecycleLineageExpiresAt(recordedAt),
    );
  };

  // Upgrade bridge: seed the privacy-bounded lineage from exact issuer
  // watermarks already present on installation rows. An interrupted legacy
  // deletion has no deletion iat, so pin it to startup time and fail closed for
  // old callbacks during the one remaining JWT acceptance window.
  db.transaction(() => {
    const recordedAt = now();
    const timestamp = recordedAt.toISOString();
    pruneLifecycleAuthority(timestamp);
    const rows = db.prepare(
      `SELECT * FROM installations
        WHERE lifecycle_issued_at IS NOT NULL OR status = 'deleted'`,
    ).all() as InstallationRow[];
    for (const row of rows) {
      const lifecycleIssuedAt = row.status === "deleted"
        ? Math.max(row.lifecycle_issued_at ?? 0, Math.floor(recordedAt.getTime() / 1000))
        : row.lifecycle_issued_at;
      if (lifecycleIssuedAt === null) continue;
      recordLifecycleAuthority(
        row.workspace_id,
        lifecycleIssuedAt,
        row.status,
        row.generation,
        recordedAt,
      );
    }
  })();
  const eraseWorkspaceRows = (
    workspaceId: string,
    expectedDeletionGeneration?: number,
  ): EraseCounts | undefined => {
    let erasedGeneration: number | undefined;
    const del = (sql: string): number => db.prepare(sql).run(workspaceId).changes;
    const run = db.transaction((): EraseCounts | undefined => {
      const installation = db.prepare(
        "SELECT status, generation FROM installations WHERE workspace_id = ?",
      ).get(workspaceId) as Pick<InstallationRow, "status" | "generation"> | undefined;
      if (
        expectedDeletionGeneration !== undefined &&
        (!installation ||
          installation.status !== "deleted" ||
          installation.generation !== expectedDeletionGeneration)
      ) {
        return undefined;
      }
      erasedGeneration = installation?.generation;
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
      const installationAttestations = del("DELETE FROM installation_attestations WHERE workspace_id = ?");
      const installations = del("DELETE FROM installations WHERE workspace_id = ?");
      return {
        installations,
        installationAttestations,
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
    const erased = run();
    if (erasedGeneration !== undefined) rememberGeneration(workspaceId, erasedGeneration);
    return erased;
  };

  const tombstoneLifecycle = (
    workspaceId: string,
    lifecycleIssuedAt: number,
    recordAbsent: boolean,
  ): LifecycleDeletionResult => {
    const recordedAt = now();
    const timestamp = recordedAt.toISOString();
    const result = db.transaction((): LifecycleDeletionResult => {
      const current = db.prepare(
        "SELECT * FROM installations WHERE workspace_id = ?",
      ).get(workspaceId) as InstallationRow | undefined;
      const authority = lifecycleAuthority(workspaceId, current, timestamp);
      if (authority && lifecycleIssuedAt < authority.lifecycleIssuedAt) {
        return { accepted: false, generation: current?.generation };
      }
      if (!current) {
        if (recordAbsent) {
          recordLifecycleAuthority(
            workspaceId,
            lifecycleIssuedAt,
            "deleted",
            authority?.installationGeneration ?? 0,
            recordedAt,
          );
        }
        return { accepted: recordAbsent, generation: authority?.installationGeneration };
      }
      if (current.status === "deleted") {
        db.prepare(
          `UPDATE installations
              SET lifecycle_issued_at = MAX(COALESCE(lifecycle_issued_at, 0), ?),
                  updated_at = ?
            WHERE workspace_id = ?`,
        ).run(lifecycleIssuedAt, timestamp, workspaceId);
        recordLifecycleAuthority(
          workspaceId,
          lifecycleIssuedAt,
          "deleted",
          current.generation,
          recordedAt,
        );
        return { accepted: true, generation: current.generation };
      }
      const currentToken = openToken(current.addon_token_ciphertext);
      if (currentToken) {
        db.prepare(
          `INSERT OR IGNORE INTO retired_installation_tokens (
             token_fingerprint_sha256, retired_at
           ) VALUES (?, ?)`,
        ).run(hashRetiredInstallationToken(currentToken), timestamp);
      }
      const generation = Math.max(
        current.generation,
        lastGenerations.get(workspaceId) ?? 0,
        authority?.installationGeneration ?? 0,
      ) + 1;
      db.prepare(
        `UPDATE installations
            SET status = 'deleted', addon_token_ciphertext = ?, generation = ?,
                lifecycle_issued_at = ?, deletion_started_at = ?, updated_at = ?
          WHERE workspace_id = ?`,
      ).run(sealToken(""), generation, lifecycleIssuedAt, timestamp, timestamp, workspaceId);
      db.prepare("DELETE FROM installation_attestations WHERE workspace_id = ?")
        .run(workspaceId);
      recordLifecycleAuthority(
        workspaceId,
        lifecycleIssuedAt,
        "deleted",
        generation,
        recordedAt,
      );
      return { accepted: true, generation };
    })();
    if (result.generation !== undefined) rememberGeneration(workspaceId, result.generation);
    return result;
  };

  return {
    saveInstallation(input) {
      const recordedAt = now();
      const timestamp = recordedAt.toISOString();
      const apiUrl = optionalServiceUrl(input.apiUrl, "api");
      const backendUrl = optionalServiceUrl(input.backendUrl, "api");
      const reportsUrl = optionalServiceUrl(input.reportsUrl, "reports");
      const result = db.transaction((): InstallationSaveResult => {
        const current = db.prepare(
          "SELECT * FROM installations WHERE workspace_id = ?",
        ).get(input.workspaceId) as InstallationRow | undefined;
        const candidateRetiredFingerprint = hashRetiredInstallationToken(input.addonToken);
        const currentToken = current ? openToken(current.addon_token_ciphertext) : undefined;
        const sameToken = currentToken !== undefined
          && equalFingerprint(hashInstallationToken(currentToken), hashInstallationToken(input.addonToken));

        // INSTALLED delivery retries are authority-neutral regardless of the
        // current ACTIVE/INACTIVE state. Only STATUS ACTIVE may reactivate the
        // same token; a re-signed retry must never undo explicit revocation.
        if (sameToken) {
          return { outcome: "same_token_retry", generation: current?.generation };
        }

        const authority = lifecycleAuthority(input.workspaceId, current, timestamp);
        // A different-token replacement is a new authority generation and must
        // be strictly newer. This makes INACTIVE/DELETED win equal-second ties
        // and closes unseen old-token resurrection after the install row erases.
        if (
          input.lifecycleIssuedAt !== undefined
          && authority
          && input.lifecycleIssuedAt <= authority.lifecycleIssuedAt
        ) {
          return { outcome: "stale_lifecycle", generation: current?.generation };
        }

        // Retired tokens are workspace-unlinked and remain denied after the
        // installation row itself has been erased (including after restart).
        const retired = db.prepare(
          "SELECT 1 FROM retired_installation_tokens WHERE token_fingerprint_sha256 = ?",
        ).get(candidateRetiredFingerprint);
        if (retired) {
          return { outcome: "retired_token_replay", generation: current?.generation };
        }

        // A real replacement permanently retires its predecessor so a delayed
        // old callback cannot rotate authority backwards.
        if (currentToken) {
          db.prepare(
            `INSERT OR IGNORE INTO retired_installation_tokens (
               token_fingerprint_sha256, retired_at
             ) VALUES (?, ?)`,
          ).run(hashRetiredInstallationToken(currentToken), timestamp);
        }
        const nextGeneration = Math.max(
          current?.generation ?? 0,
          lastGenerations.get(input.workspaceId) ?? 0,
          authority?.installationGeneration ?? 0,
        ) + 1;
        db.prepare(
          `INSERT INTO installations (
             workspace_id, addon_id, addon_user_id, addon_token_ciphertext,
             api_url, backend_url, reports_url, status, generation, lifecycle_issued_at,
             deletion_started_at, installed_by_user_id, installed_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET
             addon_id = excluded.addon_id,
             addon_user_id = excluded.addon_user_id,
             addon_token_ciphertext = excluded.addon_token_ciphertext,
             api_url = excluded.api_url,
             backend_url = excluded.backend_url,
             reports_url = COALESCE(excluded.reports_url, installations.reports_url),
             status = excluded.status,
             generation = excluded.generation,
             lifecycle_issued_at = excluded.lifecycle_issued_at,
             deletion_started_at = NULL,
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
          nextGeneration,
          input.lifecycleIssuedAt ?? null,
          input.installedByUserId ?? null,
          timestamp,
          timestamp,
        );
        // Any non-duplicate callback invalidates the prior proof in the
        // same transaction. Only a row that was genuinely absent before this
        // verified callback may receive a new fresh-install attestation.
        db.prepare("DELETE FROM installation_attestations WHERE workspace_id = ?")
          .run(input.workspaceId);
        if (!current && input.freshInstallAttestation) {
          const binding = input.freshInstallAttestation;
          db.prepare(
            `INSERT INTO installation_attestations (
               workspace_id, workspace_sha256, installation_generation,
               token_fingerprint_sha256, release_sha, release_build_hash,
               server_artifact_sha256, source_relationship,
               source_binding_sha256, manifest_sha256, installed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            input.workspaceId,
            hashInstallationWorkspace(input.workspaceId),
            nextGeneration,
            hashInstallationToken(input.addonToken),
            binding.releaseSha,
            binding.releaseBuildHash,
            binding.serverArtifactSha256,
            binding.sourceRelationship,
            binding.sourceBindingSha256,
            binding.manifestSha256,
            timestamp,
          );
        }
        if (input.lifecycleIssuedAt !== undefined) {
          recordLifecycleAuthority(
            input.workspaceId,
            input.lifecycleIssuedAt,
            input.status ?? "active",
            nextGeneration,
            recordedAt,
          );
        }
        return { outcome: "applied", generation: nextGeneration };
      })();
      if (result.generation !== undefined) rememberGeneration(input.workspaceId, result.generation);
      return result;
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
        generation: row.generation,
        lifecycleIssuedAt: row.lifecycle_issued_at ?? undefined,
        deletionStartedAt: row.deletion_started_at ?? undefined,
        installedByUserId: row.installed_by_user_id ?? undefined,
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
      };
    },

    getAuthenticatedInstallationAttestation(workspaceId, addonToken) {
      const row = db.prepare(
        `SELECT a.*
           FROM installation_attestations a
           JOIN installations i ON i.workspace_id = a.workspace_id
          WHERE a.workspace_id = ?
            AND i.status = 'active'
            AND i.generation = a.installation_generation`,
      ).get(workspaceId) as InstallationAttestationRow | undefined;
      if (!row) return undefined;
      const supplied = Buffer.from(hashInstallationToken(addonToken), "hex");
      const expected = Buffer.from(row.token_fingerprint_sha256, "hex");
      if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
        return undefined;
      }
      return {
        workspaceSha256: row.workspace_sha256,
        installationGeneration: row.installation_generation,
        releaseSha: row.release_sha,
        releaseBuildHash: row.release_build_hash,
        serverArtifactSha256: row.server_artifact_sha256,
        sourceRelationship: row.source_relationship,
        sourceBindingSha256: row.source_binding_sha256,
        manifestSha256: row.manifest_sha256,
        installedAt: row.installed_at,
      };
    },

    setInstallationStatus(workspaceId, status, lifecycleIssuedAt) {
      const recordedAt = now();
      const timestamp = recordedAt.toISOString();
      const result = db.transaction((): InstallationStatusResult => {
        const current = db.prepare(
          "SELECT * FROM installations WHERE workspace_id = ?",
        ).get(workspaceId) as InstallationRow | undefined;
        const authority = lifecycleAuthority(workspaceId, current, timestamp);
        if (
          lifecycleIssuedAt !== undefined
          && authority
          && (
            lifecycleIssuedAt < authority.lifecycleIssuedAt
            || (
              lifecycleIssuedAt === authority.lifecycleIssuedAt
              && lifecycleAuthorityRank(status) < lifecycleAuthorityRank(authority.authorityState)
            )
          )
        ) {
          return { outcome: "stale_lifecycle", generation: current?.generation };
        }
        // Only a fresh INSTALLED event carries a replacement token and may
        // revive a deleted installation. Status events cannot turn the durable,
        // tokenless deletion tombstone back into an apparently active install.
        if (!current || current.status === "deleted") {
          if (status === "inactive" && lifecycleIssuedAt !== undefined) {
            recordLifecycleAuthority(
              workspaceId,
              lifecycleIssuedAt,
              current?.status === "deleted" ? "deleted" : "inactive",
              current?.generation ?? authority?.installationGeneration ?? 0,
              recordedAt,
            );
            return { outcome: "applied", generation: current?.generation };
          }
          return { outcome: "not_installed", generation: current?.generation };
        }
        const nextGeneration = status === "active" && current.status !== "active"
          ? Math.max(
              current.generation,
              lastGenerations.get(workspaceId) ?? 0,
              authority?.installationGeneration ?? 0,
            ) + 1
          : current.generation;
        db.prepare(
          `UPDATE installations
              SET status = ?, generation = ?,
                  lifecycle_issued_at = COALESCE(?, lifecycle_issued_at),
                  deletion_started_at = CASE WHEN ? = 'active' THEN NULL ELSE deletion_started_at END,
                  updated_at = ?
            WHERE workspace_id = ?`,
        ).run(status, nextGeneration, lifecycleIssuedAt ?? null, status, timestamp, workspaceId);
        // A fresh-install proof is valid for one uninterrupted active
        // generation only. Status churn must not resurrect it.
        db.prepare("DELETE FROM installation_attestations WHERE workspace_id = ?")
          .run(workspaceId);
        if (lifecycleIssuedAt !== undefined) {
          recordLifecycleAuthority(
            workspaceId,
            lifecycleIssuedAt,
            status,
            nextGeneration,
            recordedAt,
          );
        }
        return { outcome: "applied", generation: nextGeneration };
      })();
      if (result.generation !== undefined) rememberGeneration(workspaceId, result.generation);
      return result;
    },

    tombstoneInstallationForLifecycle(workspaceId, lifecycleIssuedAt) {
      return tombstoneLifecycle(workspaceId, lifecycleIssuedAt, true);
    },

    tombstoneInstallation(workspaceId) {
      const current = db.prepare(
        "SELECT * FROM installations WHERE workspace_id = ?",
      ).get(workspaceId) as InstallationRow | undefined;
      if (!current) return undefined;
      const lifecycleIssuedAt = current.lifecycle_issued_at
        ?? Math.floor(now().getTime() / 1000);
      const result = tombstoneLifecycle(workspaceId, lifecycleIssuedAt, false);
      return result.accepted && result.generation !== undefined
        ? { generation: result.generation }
        : undefined;
    },

    listDeletionTombstones() {
      return (db.prepare(
        "SELECT workspace_id FROM installations WHERE status = 'deleted' ORDER BY workspace_id",
      ).all() as Array<{ workspace_id: string }>).map((row) => row.workspace_id);
    },

    eraseWorkspace(workspaceId) {
      const current = db.prepare(
        "SELECT * FROM installations WHERE workspace_id = ?",
      ).get(workspaceId) as InstallationRow | undefined;
      if (current && current.status !== "deleted") {
        tombstoneLifecycle(
          workspaceId,
          Math.max(current.lifecycle_issued_at ?? 0, Math.floor(now().getTime() / 1000)),
          false,
        );
      }
      return eraseWorkspaceRows(workspaceId)!;
    },

    eraseWorkspaceForDeletion(workspaceId, generation) {
      return eraseWorkspaceRows(workspaceId, generation);
    },
  };
}
