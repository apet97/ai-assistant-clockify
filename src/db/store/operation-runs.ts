import { randomUUID } from "node:crypto";
import type {
  OperationRun,
  OperationRunStatus,
  OperationStep,
  PrepareCompensationStepInput,
  PrepareOperationRunInput,
  PrepareOperationStepInput,
  SanitizedOperationRun,
  StartupReconciliationOperation,
  StoreContext,
} from "./context.js";
import {
  actionResultJson,
  buildActionResultSummary,
  type ActionResultRef,
} from "../action-results.js";
import {
  boundedCompleteSanitizedJson,
  boundedSanitizedJson,
  exactNonsecretJson,
  jsonByteLength,
  sanitizeCompleteJson,
} from "../../harness/safe-json.js";
import { hashOperation } from "../../harness/confirmations.js";
import { successReceipt } from "../../harness/receipts.js";

interface OperationRunRow {
  id: string;
  request_id: string | null;
  confirmation_id: string | null;
  session_id: string;
  workspace_id: string;
  admin_user_id: string;
  action_name: string;
  action_fingerprint: string;
  catalog_hash: string;
  operation_hash: string;
  status: OperationRunStatus;
  action_result_id: string | null;
  operation_json: string;
  reconciled_at: string | null;
  reconciliation_json: string | null;
  capability_id: string | null;
  capability_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationStepRow {
  id: string;
  operation_id: string;
  step_index: number;
  plan_step_id: string;
  name: string;
  kind: OperationStep["kind"];
  status: OperationStep["status"];
  external_id: string | null;
  target_fingerprint: string | null;
  effect_json: string | null;
  detail_json: string | null;
  dispatched_at: string | null;
  settled_at: string | null;
  compensates_step_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PersistedPlanDescriptor {
  id: string;
  kind: "primary" | "compensation";
  targetFingerprint?: string;
}

/** Parse only the plan surface needed to authorize a host compensation. A
 * malformed/duplicate descriptor fails closed instead of letting a journal row
 * manufacture authority that was never persisted with the operation. */
function persistedPlanDescriptors(operationJson: string): PersistedPlanDescriptor[] | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(operationJson) as unknown;
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
  const plan = (decoded as { mutationPlan?: unknown }).mutationPlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return undefined;
  const record = plan as { mode?: unknown; steps?: unknown };
  if (!(["single", "curated", "batch"] as unknown[]).includes(record.mode) || !Array.isArray(record.steps) || record.steps.length === 0) {
    return undefined;
  }
  if (record.mode === "single" && record.steps.length !== 1) return undefined;
  const ids = new Set<string>();
  const descriptors: PersistedPlanDescriptor[] = [];
  for (const value of record.steps) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const step = value as {
      id?: unknown;
      kind?: unknown;
      targetFingerprint?: unknown;
      reconciliationStrategy?: unknown;
    };
    if (typeof step.id !== "string" || step.id.length === 0 || ids.has(step.id) ||
      (step.kind !== "primary" && step.kind !== "compensation") ||
      (step.targetFingerprint !== undefined && typeof step.targetFingerprint !== "string") ||
      (step.reconciliationStrategy !== undefined &&
        !["create", "update", "delete", "state-command", "composed"].includes(step.reconciliationStrategy as string))) {
      return undefined;
    }
    ids.add(step.id);
    descriptors.push({
      id: step.id,
      kind: step.kind,
      ...(typeof step.targetFingerprint === "string" ? { targetFingerprint: step.targetFingerprint } : {}),
    });
  }
  return descriptors;
}

function matchesPersistedDescriptor(
  descriptors: readonly PersistedPlanDescriptor[],
  row: {
    step_index: number;
    plan_step_id: string;
    kind: OperationStep["kind"];
    target_fingerprint: string | null;
  },
  expectedKind: PersistedPlanDescriptor["kind"],
): boolean {
  const descriptor = descriptors[row.step_index];
  return !!descriptor && descriptor.id === row.plan_step_id &&
    descriptor.kind === expectedKind && row.kind === expectedKind &&
    (descriptor.targetFingerprint === undefined || descriptor.targetFingerprint === row.target_fingerprint);
}

function toRun(row: OperationRunRow): OperationRun {
  let persisted: {
    operation?: unknown;
    mutationPlan?: PrepareOperationRunInput["mutationPlan"];
  } = {};
  try {
    const decoded = JSON.parse(row.operation_json) as unknown;
    if (decoded && typeof decoded === "object") persisted = decoded as typeof persisted;
  } catch {
    // A corrupt legacy row must remain inspectable as metadata, never crash a
    // scoped status endpoint or startup recovery pass.
  }
  return {
    id: row.id,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.confirmation_id ? { confirmationId: row.confirmation_id } : {}),
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    actionName: row.action_name,
    actionFingerprint: row.action_fingerprint,
    catalogHash: row.catalog_hash,
    operationHash: row.operation_hash,
    ...(Object.hasOwn(persisted, "operation") ? { operation: persisted.operation } : {}),
    ...(persisted.mutationPlan ? { mutationPlan: persisted.mutationPlan } : {}),
    ...(row.capability_id ? { capabilityId: row.capability_id } : {}),
    ...(row.capability_hash ? { capabilityHash: row.capability_hash } : {}),
    status: row.status,
    ...(row.action_result_id ? { actionResultId: row.action_result_id } : {}),
    ...(row.reconciled_at ? { reconciledAt: row.reconciled_at } : {}),
    ...(row.reconciliation_json ? { reconciliation: JSON.parse(row.reconciliation_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStep(row: OperationStepRow): OperationStep {
  return {
    id: row.id,
    operationId: row.operation_id,
    planStepId: row.plan_step_id,
    index: row.step_index,
    name: row.name,
    kind: row.kind,
    status: row.status,
    ...(row.target_fingerprint ? { targetFingerprint: row.target_fingerprint } : {}),
    ...(row.compensates_step_id ? { compensatesStepId: row.compensates_step_id } : {}),
    ...(row.external_id ? { externalId: row.external_id } : {}),
    ...(row.effect_json ? { effect: JSON.parse(row.effect_json) } : {}),
    ...(row.detail_json ? { detail: JSON.parse(row.detail_json) } : {}),
    ...(row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {}),
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function completeStartupEvidence(value: unknown): unknown {
  const safe = sanitizeCompleteJson(value);
  if (jsonByteLength(safe) > 65_536) throw new Error("startup_evidence_too_large");
  return safe;
}

function hasValidPersistedOperationHash(run: OperationRun): boolean {
  const operation = run.operation;
  const confirmed = run.confirmationId !== undefined;
  if (confirmed && (!operation || typeof operation !== "object" ||
    (operation as Record<string, unknown>).operationId !== run.id ||
    (operation as Record<string, unknown>).actionName !== run.actionName)) return false;
  if (confirmed && hashOperation({ mutationPlan: (operation as Record<string, unknown>).mutationPlan }) !==
    hashOperation({ mutationPlan: run.mutationPlan })) {
    return false;
  }
  const expected = confirmed
    ? hashOperation(operation)
    : hashOperation({ actionName: run.actionName, operation, mutationPlan: run.mutationPlan });
  return expected === run.operationHash;
}

export function buildOperationRunStore(ctx: StoreContext): {
  prepareOperationRun(input: PrepareOperationRunInput): string;
  markOperationExecuting(id: string): boolean;
  settleOperationRun(id: string, status: Exclude<OperationRunStatus, "prepared" | "executing">, actionResultId?: string): void;
  settleOperationResult(
    id: string,
    status: Exclude<OperationRunStatus, "prepared" | "executing">,
    result: unknown,
  ): ActionResultRef;
  getOperationRun(id: string): OperationRun | undefined;
  getScopedOperationRun(id: string, workspaceId: string, adminUserId: string, sessionId: string): SanitizedOperationRun | undefined;
  listScopedOperationRuns(workspaceId: string, adminUserId: string, sessionId: string, limit?: number): SanitizedOperationRun[];
  listStartupReconciliationCandidates(): StartupReconciliationOperation[];
  recordOperationReconciliation(id: string, stepId: string, result: unknown, authoritative: boolean): void;
  settleStartupReconciliation(id: string, stepId: string, result: unknown): ActionResultRef;
  prepareOperationStep(input: PrepareOperationStepInput): string;
  markOperationStepExecuting(id: string, operationId?: string): boolean;
  settleOperationStep(
    id: string,
    status: "succeeded" | "definitive_failed" | "outcome_unknown",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
    operationId?: string,
  ): void;
  settleOperationStepDegraded(
    id: string,
    status: "succeeded" | "definitive_failed" | "outcome_unknown",
    detail: { externalId?: string; detail: unknown },
    operationId?: string,
  ): void;
  settleReconciledStep(
    id: string,
    status: "succeeded" | "definitive_failed",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
    operationId?: string,
  ): void;
  prepareCompensationStep(input: PrepareCompensationStepInput): string;
  markOperationStepCompensating(id: string, operationId?: string): boolean;
  settleCompensationStep(
    id: string,
    status: "compensated" | "compensation_failed" | "outcome_unknown",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
    operationId?: string,
  ): void;
  settleCompensationStepDegraded(
    id: string,
    status: "compensated" | "compensation_failed" | "outcome_unknown",
    detail: { externalId?: string; detail: unknown },
    operationId?: string,
  ): void;
  listOperationSteps(operationId: string): OperationStep[];
  recordActionResult(input: {
    workspaceId: string;
    adminUserId: string;
    sessionId?: string;
    actionName: string;
    status: Exclude<OperationRunStatus, "prepared" | "executing">;
    result: unknown;
    operationId?: string;
  }): ActionResultRef;
} {
  const { db, nowIso } = ctx;
  const store: ReturnType<typeof buildOperationRunStore> = {
    prepareOperationRun(input) {
      const id = input.id ?? randomUUID();
      const timestamp = nowIso();
      const operationEnvelope = exactNonsecretJson({
        ...(input.operation !== undefined ? { operation: input.operation } : {}),
        ...(input.mutationPlan ? { mutationPlan: input.mutationPlan } : {}),
      }, 1_000_000);
      db.prepare(
        `INSERT INTO operation_runs (
           id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
           action_name, action_fingerprint, catalog_hash, operation_hash,
           operation_json, capability_id, capability_hash, status, action_result_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
      ).run(
        id,
        input.requestId ?? null,
        input.confirmationId ?? null,
        input.sessionId,
        input.workspaceId,
        input.adminUserId,
        input.actionName,
        input.actionFingerprint,
        input.catalogHash,
        input.operationHash,
        actionResultJson(operationEnvelope),
        input.capabilityId ?? null,
        input.capabilityHash ?? null,
        timestamp,
        timestamp,
      );
      return id;
    },
    markOperationExecuting(id) {
      return db.prepare(
        "UPDATE operation_runs SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'prepared'",
      ).run(nowIso(), id).changes === 1;
    },
    settleOperationRun(id, status, actionResultId) {
      db.prepare(
        "UPDATE operation_runs SET status = ?, action_result_id = ?, updated_at = ? WHERE id = ?",
      ).run(status, actionResultId ?? null, nowIso(), id);
    },
    settleOperationResult(id, status, result) {
      return db.transaction((): ActionResultRef => {
        const operation = db.prepare(
          `SELECT session_id, workspace_id, admin_user_id, action_name, status, action_result_id
             FROM operation_runs WHERE id = ?`,
        ).get(id) as {
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          action_name: string;
          status: OperationRunStatus;
          action_result_id: string | null;
        } | undefined;
        if (!operation) throw new Error("operation_not_found");
        if (operation.action_result_id) {
          const existing = db.prepare(
            "SELECT kind, summary_json FROM action_results WHERE id = ?",
          ).get(operation.action_result_id) as { kind: ActionResultRef["kind"]; summary_json: string } | undefined;
          if (!existing) throw new Error("operation_result_not_found");
          return { id: operation.action_result_id, kind: existing.kind, summary: JSON.parse(existing.summary_json) };
        }
        const settlesPreparedDenial = operation.status === "prepared" && status === "definitive_failed";
        if (operation.status !== "executing" && !settlesPreparedDenial) {
          throw new Error("operation_not_executing");
        }
        const actionResultId = randomUUID();
        const summary = buildActionResultSummary(actionResultId, result);
        db.prepare(
          `INSERT INTO action_results (
             id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
             result_json, summary_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          actionResultId,
          id,
          operation.workspace_id,
          operation.admin_user_id,
          operation.session_id,
          operation.action_name,
          status,
          actionResultJson(result),
          actionResultJson(summary),
          nowIso(),
        );
        const update = db.prepare(
          `UPDATE operation_runs SET status = ?, action_result_id = ?, updated_at = ?
            WHERE id = ? AND status = ? AND action_result_id IS NULL`,
        ).run(status, actionResultId, nowIso(), id, operation.status);
        if (update.changes !== 1) throw new Error("operation_not_executing");
        return { id: actionResultId, kind: status, summary };
      })();
    },
    getOperationRun(id) {
      const row = db.prepare("SELECT * FROM operation_runs WHERE id = ?").get(id) as OperationRunRow | undefined;
      return row ? toRun(row) : undefined;
    },
    getScopedOperationRun(id, workspaceId, adminUserId, sessionId) {
      const row = db.prepare(
        `SELECT o.*, a.kind AS result_kind, a.summary_json
           FROM operation_runs o
           LEFT JOIN action_results a ON a.id = o.action_result_id
             AND a.operation_id = o.id
             AND a.workspace_id = o.workspace_id
             AND a.admin_user_id = o.admin_user_id
             AND a.session_id = o.session_id
          WHERE o.id = ? AND o.workspace_id = ? AND o.admin_user_id = ? AND o.session_id = ?`,
      ).get(id, workspaceId, adminUserId, sessionId) as (OperationRunRow & {
        result_kind: ActionResultRef["kind"] | null;
        summary_json: string | null;
      }) | undefined;
      if (!row) return undefined;
      const run = toRun(row);
      const rawPlan = run.mutationPlan as unknown;
      const validModes = new Set(["single", "curated", "batch"]);
      const planRecord = rawPlan && typeof rawPlan === "object" ? rawPlan as Record<string, unknown> : undefined;
      const planMode = typeof planRecord?.mode === "string" && validModes.has(planRecord.mode)
        ? planRecord.mode as "single" | "curated" | "batch"
        : undefined;
      const rawPlanSteps = Array.isArray(planRecord?.steps) ? planRecord.steps : [];
      const allPlanSteps = rawPlanSteps.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const step = value as Record<string, unknown>;
        if (typeof step.id !== "string" || (step.kind !== "primary" && step.kind !== "compensation")) return [];
        return [{
          id: step.id,
          kind: step.kind as "primary" | "compensation",
          ...(typeof step.targetFingerprint === "string" ? { targetFingerprint: step.targetFingerprint } : {}),
        }];
      });
      const planLimit = 50;
      const rows = db.prepare(
        `SELECT * FROM operation_steps
          WHERE operation_id = ? ORDER BY step_index ASC LIMIT ?`,
      ).all(id, planLimit + 1) as OperationStepRow[];
      const rawReconciliation = run.reconciliation && typeof run.reconciliation === "object"
        ? run.reconciliation as { stepId?: unknown; authoritative?: unknown; result?: unknown }
        : undefined;
      const reconciliationResult = rawReconciliation?.result && typeof rawReconciliation.result === "object"
        ? rawReconciliation.result as { reason?: unknown }
        : undefined;
      return {
        id: run.id,
        actionName: run.actionName.slice(0, 256),
        status: run.status,
        ...(planMode
          ? {
              plan: {
                mode: planMode,
                steps: allPlanSteps.slice(0, planLimit).map((step) => ({
                  id: step.id.slice(0, 256),
                  kind: step.kind,
                  ...(step.targetFingerprint ? { targetFingerprint: step.targetFingerprint.slice(0, 256) } : {}),
                })),
                ...(rawPlanSteps.length > planLimit || allPlanSteps.length !== rawPlanSteps.length
                  ? { truncated: true, originalStepCount: rawPlanSteps.length }
                  : {}),
              },
            }
          : {}),
        steps: rows.slice(0, planLimit).map((step) => ({
          planStepId: step.plan_step_id.slice(0, 256),
          index: step.step_index,
          name: step.name.slice(0, 256),
          kind: step.kind,
          status: step.status,
          ...(step.target_fingerprint ? { targetFingerprint: step.target_fingerprint.slice(0, 256) } : {}),
          ...(step.dispatched_at ? { dispatchedAt: step.dispatched_at } : {}),
          ...(step.settled_at ? { settledAt: step.settled_at } : {}),
          createdAt: step.created_at,
          updatedAt: step.updated_at,
        })),
        ...(rows.length > planLimit ? { stepsTruncated: true } : {}),
        ...(row.action_result_id && row.result_kind && row.summary_json
          ? {
              result: {
                id: row.action_result_id,
                kind: row.result_kind,
                summary: boundedSanitizedJson(JSON.parse(row.summary_json), 65_536),
              },
            }
          : {}),
        ...(rawReconciliation
          ? {
              reconciliation: {
                ...(typeof rawReconciliation.stepId === "string" ? { stepId: rawReconciliation.stepId.slice(0, 256) } : {}),
                ...(typeof rawReconciliation.authoritative === "boolean" ? { authoritative: rawReconciliation.authoritative } : {}),
                ...(typeof reconciliationResult?.reason === "string" ? { reason: reconciliationResult.reason.slice(0, 256) } : {}),
              },
            }
          : {}),
        ...(run.reconciledAt ? { reconciledAt: run.reconciledAt } : {}),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      };
    },
    listScopedOperationRuns(workspaceId, adminUserId, sessionId, limit = 20) {
      const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
      const ids = db.prepare(
        `SELECT id FROM operation_runs
          WHERE workspace_id = ? AND admin_user_id = ? AND session_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(workspaceId, adminUserId, sessionId, boundedLimit) as Array<{ id: string }>;
      return ids.reverse().flatMap(({ id }) => {
        const view = scopedView(id, workspaceId, adminUserId, sessionId);
        return view ? [view] : [];
      });
    },
    listStartupReconciliationCandidates() {
      const operations = db.prepare(
        `SELECT * FROM operation_runs
          WHERE status = 'outcome_unknown' AND reconciled_at IS NULL
          ORDER BY created_at ASC, id ASC`,
      ).all() as OperationRunRow[];
      const strategies = new Set(["create", "update", "delete", "state-command", "composed"]);
      return operations.flatMap((row): StartupReconciliationOperation[] => {
        const run = toRun(row);
        if (!hasValidPersistedOperationHash(run)) return [];
        const plan = run.mutationPlan;
        if (!plan || !Array.isArray(plan.steps)) return [];
        let safeOperation: unknown;
        let safePlan: typeof plan;
        let targetSnapshots: unknown[];
        try {
          safeOperation = completeStartupEvidence(run.operation);
          safePlan = completeStartupEvidence(plan) as typeof plan;
          const source = safeOperation && typeof safeOperation === "object" && !Array.isArray(safeOperation)
            ? (safeOperation as { targetSnapshots?: unknown }).targetSnapshots
            : undefined;
          targetSnapshots = Array.isArray(source)
            ? completeStartupEvidence(source) as unknown[]
            : [];
        } catch {
          // A startup evaluator must receive complete evidence. Oversized or
          // malformed persisted intent remains unknown instead of being guessed.
          return [];
        }
        const planIds = plan.steps.flatMap((step) => step && typeof step === "object" && typeof step.id === "string" ? [step.id] : []);
        if (planIds.length !== plan.steps.length || new Set(planIds).size !== planIds.length) return [];
        const steps = (db.prepare(
          `SELECT * FROM operation_steps
            WHERE operation_id = ? AND kind = 'primary' AND status = 'outcome_unknown'
            ORDER BY step_index ASC`,
        ).all(row.id) as OperationStepRow[]).flatMap((step) => {
          const exact = plan.steps[step.step_index];
          const strategy = exact && typeof exact === "object" && exact.id === step.plan_step_id && exact.kind === "primary" &&
            typeof exact.reconciliationStrategy === "string" && strategies.has(exact.reconciliationStrategy)
            ? exact.reconciliationStrategy
            : undefined;
          return strategy
            ? [{
                id: step.id,
                status: "outcome_unknown" as const,
                kind: "primary" as const,
                planStepId: step.plan_step_id,
                strategy: strategy as StartupReconciliationOperation["steps"][number]["strategy"],
                ...(step.target_fingerprint ? { targetFingerprint: step.target_fingerprint.slice(0, 256) } : {}),
                evidence: completeStartupEvidence(step.detail_json ? JSON.parse(step.detail_json) : {}),
              }]
            : [];
        });
        return steps.length > 0
          ? [{
              id: run.id,
              status: "outcome_unknown",
              sessionId: run.sessionId,
              workspaceId: run.workspaceId,
              adminUserId: run.adminUserId,
              actionName: run.actionName,
              actionFingerprint: run.actionFingerprint,
              catalogHash: run.catalogHash,
              operationHash: run.operationHash,
              operation: safeOperation,
              mutationPlan: safePlan,
              targetSnapshots,
              steps,
            }]
          : [];
      });
    },
    recordOperationReconciliation(id, stepId, result, authoritative) {
      db.transaction(() => {
        const step = db.prepare(
          `SELECT id FROM operation_steps
            WHERE id = ? AND operation_id = ? AND kind = 'primary' AND status = 'outcome_unknown'`,
        ).get(stepId, id);
        if (!step) throw new Error("reconciliation_step_not_unknown");
        const raw = result && typeof result === "object" ? result as Record<string, unknown> : {};
        const stableReasons = new Set([
          "authoritative_match", "non_unique_or_missing", "invalid_evidence", "binding_mismatch",
          "action_fingerprint_drift", "catalog_hash_drift", "read_failed", "incomplete_evidence",
          "evaluation_failed", "not_found", "non_unique", "truncated", "post_list_truncated",
          "reconciliation_settlement_failed", "handler_missing", "installation_unavailable",
        ]);
        const scalarResult = Object.entries(raw).slice(0, 50).reduce<Record<string, string | number | boolean | null>>(
          (safe, [key, value]) => {
            if (["binding", "evidence"].includes(key) || /token|secret|header|authorization|cookie|bytes|binary/i.test(key)) return safe;
            if (key === "reason" && typeof value === "string") {
              safe.reason = stableReasons.has(value) ? value : "invalid_reconciliation_reason";
            } else if (["matches", "matchCount", "rowCount", "complete", "compatible"].includes(key) &&
              (typeof value === "number" || typeof value === "boolean" || value === null)) {
              safe[key] = value;
            }
            return safe;
          },
          {},
        );
        const rawBinding = raw.binding && typeof raw.binding === "object"
          ? raw.binding as Record<string, unknown>
          : undefined;
        const bindingKeys = [
          "operationId", "stepId", "planStepId", "strategy", "actionName", "actionFingerprint", "catalogHash",
        ];
        const safeBinding = rawBinding
          ? bindingKeys.reduce<Record<string, string>>((safe, key) => {
              const value = rawBinding[key];
              if (typeof value === "string") safe[key] = value.slice(0, 256);
              return safe;
            }, {})
          : undefined;
        const safeResult = {
          ...scalarResult,
          ...(safeBinding ? { binding: safeBinding } : {}),
          ...(raw.evidence !== undefined ? { evidence: boundedSanitizedJson(raw.evidence, 50_000) } : {}),
        };
        const timestamp = nowIso();
        const updated = db.prepare(
          `UPDATE operation_runs
              SET reconciled_at = ?, reconciliation_json = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          timestamp,
          actionResultJson(boundedSanitizedJson({ stepId: stepId.slice(0, 256), authoritative, result: safeResult }, 65_536)),
          timestamp,
          id,
        );
        if (updated.changes !== 1) throw new Error("operation_not_found");
      })();
    },
    settleStartupReconciliation(id, stepId, result) {
      return db.transaction((): ActionResultRef => {
        const operationRow = db.prepare("SELECT * FROM operation_runs WHERE id = ?").get(id) as OperationRunRow | undefined;
        if (!operationRow) throw new Error("reconciliation_operation_not_found");
        const run = toRun(operationRow);
        if (run.status !== "outcome_unknown" || !hasValidPersistedOperationHash(run)) {
          throw new Error("reconciliation_operation_not_unknown");
        }
        const step = db.prepare(
          `SELECT * FROM operation_steps
            WHERE id = ? AND operation_id = ? AND kind = 'primary' AND status = 'outcome_unknown'`,
        ).get(stepId, id) as OperationStepRow | undefined;
        if (!step) throw new Error("reconciliation_step_not_unknown");
        const plan = run.mutationPlan;
        const descriptor = plan?.steps[step.step_index];
        if (!descriptor || descriptor.id !== step.plan_step_id || descriptor.kind !== "primary" ||
          descriptor.reconciliationStrategy !== (result as { binding?: { strategy?: unknown } })?.binding?.strategy) {
          throw new Error("reconciliation_plan_drift");
        }
        const raw = result && typeof result === "object" && !Array.isArray(result)
          ? result as Record<string, unknown>
          : undefined;
        const binding = raw?.binding && typeof raw.binding === "object" && !Array.isArray(raw.binding)
          ? raw.binding as Record<string, unknown>
          : undefined;
        if (raw?.authoritative !== true || raw.reason !== "authoritative_match" ||
          binding?.operationId !== id || binding.stepId !== stepId || binding.planStepId !== step.plan_step_id ||
          binding.actionName !== run.actionName || binding.actionFingerprint !== run.actionFingerprint ||
          binding.catalogHash !== run.catalogHash) {
          throw new Error("authoritative_reconciliation_required");
        }

        const primaryPlanSteps = plan.steps.filter((value) => value.kind === "primary");
        const journalRows = db.prepare(
          "SELECT * FROM operation_steps WHERE operation_id = ? AND kind = 'primary' ORDER BY step_index ASC",
        ).all(id) as OperationStepRow[];
        const fullyApplied = primaryPlanSteps.length === journalRows.length && journalRows.every((row) =>
          row.id === stepId ? row.status === "outcome_unknown" : row.status === "succeeded",
        );
        const status = fullyApplied ? "succeeded" as const : "partial" as const;
        const timestamp = nowIso();
        const safeReconciliation = boundedSanitizedJson({ stepId: stepId.slice(0, 256), authoritative: true, result }, 65_536);
        const rawEvidence = raw.evidence && typeof raw.evidence === "object" && !Array.isArray(raw.evidence)
          ? raw.evidence as { candidates?: unknown }
          : undefined;
        const exactCandidate = Array.isArray(rawEvidence?.candidates) && rawEvidence.candidates.length === 1 &&
          rawEvidence.candidates[0] && typeof rawEvidence.candidates[0] === "object"
          ? rawEvidence.candidates[0] as { ref?: unknown }
          : undefined;
        const exactRef = exactCandidate?.ref && typeof exactCandidate.ref === "object" && !Array.isArray(exactCandidate.ref)
          ? exactCandidate.ref as { id?: unknown }
          : undefined;
        const externalId = typeof exactRef?.id === "string" ? exactRef.id.slice(0, 256) : undefined;
        const stepUpdated = db.prepare(
          `UPDATE operation_steps
              SET status = 'succeeded', external_id = COALESCE(?, external_id),
                  detail_json = ?, settled_at = ?, updated_at = ?
            WHERE id = ? AND operation_id = ? AND kind = 'primary' AND status = 'outcome_unknown'`,
        ).run(
          externalId ?? null,
          actionResultJson(boundedCompleteSanitizedJson({
            ...(step.detail_json ? { preDispatch: JSON.parse(step.detail_json) as unknown } : {}),
            startupReconciliation: safeReconciliation,
          }, 65_536)),
          timestamp,
          timestamp,
          stepId,
          id,
        );
        if (stepUpdated.changes !== 1) throw new Error("reconciliation_step_not_unknown");

        const receipt = successReceipt({
          action: run.actionName,
          entity: "operation",
          ids: { workspaceId: run.workspaceId, operationId: id, externalId },
          data: { reconciled: true, stepId: step.plan_step_id },
          warnings: status === "partial"
            ? [{ code: "partial", message: "The dispatched step was reconciled, but later planned mutations were not dispatched." }]
            : [{ code: "startup_reconciled", message: "The prior unknown mutation was verified from complete Clockify evidence." }],
        });
        const canonical = status === "succeeded"
          ? { kind: "receipt" as const, receipt }
          : {
              kind: "partial" as const,
              receipt,
              message: "A prior mutation was verified, but the complete mutation plan did not finish.",
              recovery: { hint: "Refresh Clockify and create a fresh preview for any remaining changes.", retryable: false },
            };
        const actionResultId = run.actionResultId ?? randomUUID();
        const summary = buildActionResultSummary(actionResultId, canonical);
        if (run.actionResultId) {
          const updated = db.prepare(
            `UPDATE action_results SET kind = ?, result_json = ?, summary_json = ?
              WHERE id = ? AND operation_id = ? AND workspace_id = ? AND admin_user_id = ? AND session_id = ?`,
          ).run(status, actionResultJson(canonical), actionResultJson(summary), actionResultId, id, run.workspaceId, run.adminUserId, run.sessionId);
          if (updated.changes !== 1) throw new Error("reconciliation_result_not_found");
        } else {
          db.prepare(
            `INSERT INTO action_results (
               id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
               result_json, summary_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(actionResultId, id, run.workspaceId, run.adminUserId, run.sessionId, run.actionName, status,
            actionResultJson(canonical), actionResultJson(summary), timestamp);
        }
        if (run.confirmationId) {
          db.prepare(
            `UPDATE pending_confirmations
                SET status = ?, result_summary_json = ?, nonce_hash = '',
                    operation_json = NULL, agent_state_json = NULL, idempotency_key = NULL
              WHERE id = ? AND operation_id = ? AND status = 'outcome_unknown'
                AND action_result_id = ?`,
          ).run(status, actionResultJson(summary), run.confirmationId, id, actionResultId);
        }
        db.prepare(
          `UPDATE idempotency_keys SET result_summary_json = ?
            WHERE workspace_id = ? AND admin_user_id = ? AND action_result_id = ?`,
        ).run(actionResultJson(summary), run.workspaceId, run.adminUserId, actionResultId);
        const operationUpdated = db.prepare(
          `UPDATE operation_runs
              SET status = ?, action_result_id = ?, reconciled_at = ?, reconciliation_json = ?, updated_at = ?
            WHERE id = ? AND status = 'outcome_unknown'`,
        ).run(status, actionResultId, timestamp, actionResultJson(safeReconciliation), timestamp, id);
        if (operationUpdated.changes !== 1) throw new Error("reconciliation_operation_not_unknown");
        return { id: actionResultId, kind: status, summary };
      })();
    },
    prepareOperationStep(input) {
      if (input.kind !== "primary") throw new Error("compensation_requires_eligibility");
      const id = input.id ?? randomUUID();
      const timestamp = nowIso();
      db.prepare(
        `INSERT INTO operation_steps (
           id, operation_id, step_index, plan_step_id, name, kind, status,
           target_fingerprint, detail_json, compensates_step_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.operationId,
        input.index,
        input.planStepId,
        input.name,
        input.kind,
        input.targetFingerprint ?? null,
        input.preparedDetail === undefined ? null : actionResultJson(exactNonsecretJson(input.preparedDetail, 65_536)),
        input.compensatesStepId ?? null,
        timestamp,
        timestamp,
      );
      return id;
    },
    markOperationStepExecuting(id, operationId) {
      const timestamp = nowIso();
      return db.prepare(
        `UPDATE operation_steps
            SET status = 'executing', dispatched_at = ?, updated_at = ?
          WHERE id = ? AND (? IS NULL OR operation_id = ?) AND status = 'prepared'
            AND kind = 'primary'
            AND EXISTS (
              SELECT 1 FROM operation_runs
               WHERE operation_runs.id = operation_steps.operation_id
                 AND operation_runs.status = 'executing'
            )`,
      ).run(timestamp, timestamp, id, operationId ?? null, operationId ?? null).changes === 1;
    },
    settleOperationStep(id, status, detail = {}, operationId) {
      db.transaction(() => {
        const priorRow = db.prepare(
          `SELECT detail_json FROM operation_steps
            WHERE id = ? AND (? IS NULL OR operation_id = ?)
              AND status = 'executing' AND kind = 'primary'`,
        ).get(id, operationId ?? null, operationId ?? null) as { detail_json: string | null } | undefined;
        if (!priorRow) throw new Error("operation_step_not_executing");
        const prior = priorRow.detail_json ? JSON.parse(priorRow.detail_json) as unknown : undefined;
        const nextDetail = detail.detail === undefined
          ? prior
          : prior && typeof prior === "object" && !Array.isArray(prior) &&
              detail.detail && typeof detail.detail === "object" && !Array.isArray(detail.detail)
            ? { ...(prior as Record<string, unknown>), ...(detail.detail as Record<string, unknown>) }
            : detail.detail;
        const timestamp = nowIso();
        const updated = db.prepare(
          `UPDATE operation_steps
              SET status = ?, external_id = ?, effect_json = ?, detail_json = ?,
                  settled_at = ?, updated_at = ?
            WHERE id = ? AND (? IS NULL OR operation_id = ?)
              AND status = 'executing' AND kind = 'primary'`,
        ).run(
          status,
          detail.externalId ?? null,
          detail.effect === undefined ? null : actionResultJson(boundedSanitizedJson(detail.effect, 65_536)),
          nextDetail === undefined ? null : actionResultJson(boundedCompleteSanitizedJson(nextDetail, 65_536)),
          timestamp,
          timestamp,
          id,
          operationId ?? null,
          operationId ?? null,
        );
        if (updated.changes !== 1) throw new Error("operation_step_not_executing");
      })();
    },
    settleOperationStepDegraded(id, status, detail, operationId) {
      const timestamp = nowIso();
      const priorRow = db.prepare(
        `SELECT detail_json FROM operation_steps
          WHERE id = ? AND (? IS NULL OR operation_id = ?)
            AND status = 'executing' AND kind = 'primary'`,
      ).get(id, operationId ?? null, operationId ?? null) as { detail_json: string | null } | undefined;
      if (!priorRow) throw new Error("operation_step_not_executing");
      const prior = priorRow.detail_json ? JSON.parse(priorRow.detail_json) as unknown : undefined;
      const rawDegradation = detail.detail && typeof detail.detail === "object"
        ? detail.detail as Record<string, unknown>
        : {};
      const degradation = {
        journalDegraded: true,
        fullEffectPersisted: false,
        ...(typeof rawDegradation.dispatchStatus === "string"
          ? { dispatchStatus: rawDegradation.dispatchStatus.slice(0, 64) }
          : {}),
        ...(rawDegradation.settlementError === undefined
          ? {}
          : { settlementError: boundedCompleteSanitizedJson(rawDegradation.settlementError, 4_096) }),
      };
      const persistedDetail = prior && typeof prior === "object" && !Array.isArray(prior)
        ? { ...(prior as Record<string, unknown>), ...degradation }
        : { ...(prior === undefined ? {} : { preDispatch: prior }), ...degradation };
      const updated = db.prepare(
        `UPDATE operation_steps
            SET status = ?, external_id = ?, effect_json = NULL, detail_json = ?,
                settled_at = ?, updated_at = ?
          WHERE id = ? AND (? IS NULL OR operation_id = ?)
            AND status = 'executing' AND kind = 'primary'`,
      ).run(
        status,
        detail.externalId ?? null,
        actionResultJson(boundedCompleteSanitizedJson(persistedDetail, 65_536)),
        timestamp,
        timestamp,
        id,
        operationId ?? null,
        operationId ?? null,
      );
      if (updated.changes !== 1) throw new Error("operation_step_not_executing");
    },
    settleReconciledStep(id, status, detail = {}, operationId) {
      db.transaction(() => {
        const row = db.prepare(
          `SELECT s.operation_id, s.status, s.detail_json, o.reconciliation_json
             FROM operation_steps s
             JOIN operation_runs o ON o.id = s.operation_id
            WHERE s.id = ? AND (? IS NULL OR s.operation_id = ?)`,
        ).get(id, operationId ?? null, operationId ?? null) as {
          operation_id: string;
          status: OperationStep["status"];
          detail_json: string | null;
          reconciliation_json: string | null;
        } | undefined;
        const reconciliation = row?.reconciliation_json
          ? JSON.parse(row.reconciliation_json) as { stepId?: unknown; authoritative?: unknown }
          : undefined;
        if (
          row?.status !== "outcome_unknown" ||
          reconciliation?.stepId !== id ||
          reconciliation.authoritative !== true
        ) {
          throw new Error("authoritative_reconciliation_required");
        }
        const timestamp = nowIso();
        const priorDetail = row.detail_json ? JSON.parse(row.detail_json) as unknown : undefined;
        const reconciledDetail = detail.detail === undefined
          ? priorDetail
          : priorDetail && typeof priorDetail === "object" && !Array.isArray(priorDetail) &&
              detail.detail && typeof detail.detail === "object" && !Array.isArray(detail.detail)
            ? { ...(priorDetail as Record<string, unknown>), ...(detail.detail as Record<string, unknown>) }
            : detail.detail;
        const updated = db.prepare(
          `UPDATE operation_steps
              SET status = ?, external_id = ?, effect_json = ?, detail_json = ?,
                  settled_at = ?, updated_at = ?
            WHERE id = ? AND operation_id = ? AND status = 'outcome_unknown' AND kind = 'primary'`,
        ).run(
          status,
          detail.externalId ?? null,
          detail.effect === undefined ? null : actionResultJson(boundedSanitizedJson(detail.effect, 65_536)),
          reconciledDetail === undefined ? null : actionResultJson(boundedCompleteSanitizedJson(reconciledDetail, 65_536)),
          timestamp,
          timestamp,
          id,
          row.operation_id,
        );
        if (updated.changes !== 1) throw new Error("operation_step_not_unknown");
      })();
    },
    prepareCompensationStep(input) {
      return db.transaction((): string => {
        const source = db.prepare(
          `SELECT s.status AS step_status, s.operation_id, s.step_index, s.plan_step_id,
                  s.kind, s.target_fingerprint, o.status AS operation_status, o.reconciliation_json,
                  o.operation_json
             FROM operation_steps s
             JOIN operation_runs o ON o.id = s.operation_id
            WHERE s.id = ? AND s.operation_id = ? AND s.kind = 'primary'`,
        ).get(input.compensatesStepId, input.operationId) as {
          step_status: OperationStep["status"];
          operation_id: string;
          step_index: number;
          plan_step_id: string;
          kind: OperationStep["kind"];
          target_fingerprint: string | null;
          operation_status: OperationRunStatus;
          reconciliation_json: string | null;
          operation_json: string;
        } | undefined;
        const descriptors = source ? persistedPlanDescriptors(source.operation_json) : undefined;
        const sourceBound = !!source && !!descriptors &&
          matchesPersistedDescriptor(descriptors, source, "primary");
        const requestedCompensation = descriptors?.[input.index];
        const compensationBound = !!requestedCompensation &&
          requestedCompensation.id === input.planStepId && requestedCompensation.kind === "compensation" &&
          (requestedCompensation.targetFingerprint === undefined ||
            requestedCompensation.targetFingerprint === (input.targetFingerprint ?? null));
        const alreadyUsed = source ? db.prepare(
          `SELECT 1 FROM operation_steps
            WHERE operation_id = ? AND (
              step_index = ? OR plan_step_id = ? OR
              (kind = 'compensation' AND compensates_step_id = ?)
            ) LIMIT 1`,
        ).get(source.operation_id, input.index, input.planStepId, input.compensatesStepId) !== undefined : true;
        let reconciliation: { stepId?: unknown; authoritative?: unknown } | undefined;
        if (source?.reconciliation_json) {
          try {
            const decoded = JSON.parse(source.reconciliation_json) as unknown;
            if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
              reconciliation = decoded as typeof reconciliation;
            }
          } catch {
            reconciliation = undefined;
          }
        }
        const laterSteps = source && descriptors ? db.prepare(
          `SELECT step_index, plan_step_id, kind, status, target_fingerprint
             FROM operation_steps
            WHERE operation_id = ? AND step_index > ?`,
        ).all(source.operation_id, source.step_index) as Array<{
          step_index: number;
          plan_step_id: string;
          kind: OperationStep["kind"];
          status: OperationStep["status"];
          target_fingerprint: string | null;
        }> : [];
        const laterDefinitiveFailure = source?.operation_status === "executing" && !!descriptors &&
          laterSteps.some((step) => step.status === "definitive_failed" &&
            matchesPersistedDescriptor(descriptors, step, "primary"));
        const eligible = sourceBound && compensationBound && !alreadyUsed && source.step_status === "succeeded" && (
          source.operation_status === "definitive_failed" ||
          (reconciliation?.stepId === input.compensatesStepId && reconciliation.authoritative === true) ||
          laterDefinitiveFailure
        );
        if (!eligible) throw new Error("compensation_not_eligible");
        const id = input.id ?? randomUUID();
        const timestamp = nowIso();
        db.prepare(
          `INSERT INTO operation_steps (
             id, operation_id, step_index, plan_step_id, name, kind, status,
             target_fingerprint, compensates_step_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'compensation', 'prepared', ?, ?, ?, ?)`,
        ).run(
          id,
          input.operationId,
          input.index,
          input.planStepId,
          input.name,
          input.targetFingerprint ?? null,
          input.compensatesStepId,
          timestamp,
          timestamp,
        );
        return id;
      })();
    },
    markOperationStepCompensating(id, operationId) {
      return db.transaction((): boolean => {
        const row = db.prepare(
          `SELECT compensates_step_id
             FROM operation_steps
            WHERE id = ? AND (? IS NULL OR operation_id = ?)
              AND status = 'prepared' AND kind = 'compensation'`,
        ).get(id, operationId ?? null, operationId ?? null) as { compensates_step_id: string | null } | undefined;
        if (!row?.compensates_step_id) return false;
        const timestamp = nowIso();
        const compensation = db.prepare(
          `UPDATE operation_steps
              SET status = 'executing', dispatched_at = ?, updated_at = ?
            WHERE id = ? AND status = 'prepared' AND kind = 'compensation'`,
        ).run(timestamp, timestamp, id);
        const source = db.prepare(
          `UPDATE operation_steps
              SET status = 'compensating', updated_at = ?
            WHERE id = ? AND status = 'succeeded' AND kind = 'primary'`,
        ).run(timestamp, row.compensates_step_id);
        if (compensation.changes !== 1 || source.changes !== 1) {
          throw new Error("compensation_step_not_prepared");
        }
        return true;
      })();
    },
    settleCompensationStep(id, status, detail, operationId) {
      db.transaction(() => {
        const timestamp = nowIso();
        const row = db.prepare(
          `SELECT compensates_step_id FROM operation_steps
            WHERE id = ? AND (? IS NULL OR operation_id = ?)
              AND status = 'executing' AND kind = 'compensation'`,
        ).get(id, operationId ?? null, operationId ?? null) as { compensates_step_id: string | null } | undefined;
        if (!row?.compensates_step_id) throw new Error("compensation_step_not_executing");
        const updated = db.prepare(
          `UPDATE operation_steps
              SET status = ?, external_id = ?, effect_json = ?, detail_json = ?,
                  settled_at = ?, updated_at = ?
            WHERE id = ? AND status = 'executing' AND kind = 'compensation'`,
        ).run(
          status,
          detail?.externalId ?? null,
          detail?.effect === undefined ? null : actionResultJson(boundedSanitizedJson(detail.effect, 65_536)),
          detail?.detail === undefined ? null : actionResultJson(boundedCompleteSanitizedJson(detail.detail, 65_536)),
          timestamp,
          timestamp,
          id,
        );
        if (updated.changes !== 1) throw new Error("compensation_step_not_executing");
        // The primary effect was known to have succeeded before compensation.
        // A definitive/ambiguous compensation failure does not erase that truth;
        // only an authoritative successful compensation changes the source state.
        const sourceStatus = status === "compensated" ? "compensated" : "succeeded";
        const source = db.prepare(
          `UPDATE operation_steps
              SET status = ?, settled_at = CASE WHEN ? = 'compensated' THEN ? ELSE settled_at END,
                  updated_at = ?
            WHERE id = ? AND status = 'compensating'`,
        ).run(sourceStatus, status, timestamp, timestamp, row.compensates_step_id);
        if (source.changes !== 1) throw new Error("compensation_source_not_executing");
      })();
    },
    settleCompensationStepDegraded(id, status, detail, operationId) {
      db.transaction(() => {
        const timestamp = nowIso();
        const row = db.prepare(
          `SELECT compensates_step_id FROM operation_steps
            WHERE id = ? AND (? IS NULL OR operation_id = ?)
              AND status = 'executing' AND kind = 'compensation'`,
        ).get(id, operationId ?? null, operationId ?? null) as { compensates_step_id: string | null } | undefined;
        if (!row?.compensates_step_id) throw new Error("compensation_step_not_executing");
        const updated = db.prepare(
          `UPDATE operation_steps
              SET status = ?, external_id = ?, effect_json = NULL, detail_json = ?,
                  settled_at = ?, updated_at = ?
            WHERE id = ? AND status = 'executing' AND kind = 'compensation'`,
        ).run(
          status,
          detail.externalId ?? null,
          actionResultJson(boundedCompleteSanitizedJson(detail.detail, 65_536)),
          timestamp,
          timestamp,
          id,
        );
        if (updated.changes !== 1) throw new Error("compensation_step_not_executing");
        const sourceStatus = status === "compensated" ? "compensated" : "succeeded";
        const source = db.prepare(
          `UPDATE operation_steps
              SET status = ?, settled_at = CASE WHEN ? = 'compensated' THEN ? ELSE settled_at END,
                  updated_at = ?
            WHERE id = ? AND status = 'compensating'`,
        ).run(sourceStatus, status, timestamp, timestamp, row.compensates_step_id);
        if (source.changes !== 1) throw new Error("compensation_source_not_executing");
      })();
    },
    listOperationSteps(operationId) {
      const rows = db.prepare(
        "SELECT * FROM operation_steps WHERE operation_id = ? ORDER BY step_index, rowid",
      ).all(operationId) as OperationStepRow[];
      return rows.map(toStep);
    },
    recordActionResult(input) {
      const id = randomUUID();
      const resultJson = actionResultJson(input.result);
      const summary = buildActionResultSummary(id, input.result);
      db.prepare(
        `INSERT INTO action_results (
           id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
           result_json, summary_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.operationId ?? null,
        input.workspaceId,
        input.adminUserId,
        input.sessionId ?? null,
        input.actionName,
        input.status,
        resultJson,
        actionResultJson(summary),
        nowIso(),
      );
      return { id, kind: input.status, summary };
    },
  };
  function scopedView(id: string, workspaceId: string, adminUserId: string, sessionId: string): SanitizedOperationRun | undefined {
    return store.getScopedOperationRun(id, workspaceId, adminUserId, sessionId);
  }
  return store;
}
