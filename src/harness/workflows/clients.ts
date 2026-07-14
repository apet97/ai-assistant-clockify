import { z } from "zod";
import {
  clarifyResult,
  type ActionContext,
  type ActionResult,
  type CommitResult,
  type PreparedSafeWrite,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  isPartialCommitResult,
  isPreparedSafeWrite,
  isSafeWriteClarification,
  type ActionDefinition,
} from "../action.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { describePatch, resolveEntityRef } from "./resolve.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { executeCompensationStep, isJournalDegradedStep } from "../mutation-workflow.js";
import { errorReceipt } from "../receipts.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { captureStructureSnapshot, dispatchWithReconciliation, fetchStructureSnapshot, mutationPlan, reconcileDelete, requireFreshSnapshots, snapshot } from "./structure-durable.js";
import { sanitizedFingerprint } from "../safe-json.js";

/** Resolve a currency code or exact id to its workspace currencyId, or clarify. */
async function resolveCurrencyId(
  ctx: ActionContext,
  currency: string,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const currencies = await ctx.clockify.listCurrencies();
  const raw = currency.trim();
  const exactId = currencies.rows.find((candidate) => candidate.id === raw);
  if (exactId) return { ok: true, id: exactId.id };
  const want = raw.toUpperCase();
  const match = currencies.rows.find((c) => c.code.toUpperCase() === want);
  if (currencies.truncated) {
    return {
      ok: false,
      message: `Clockify returned an incomplete currency list, so I can't prove that "${currency}" identifies one currency. Provide the exact currency id or retry with a complete lookup.`,
    };
  }
  if (match) return { ok: true, id: match.id };
  const codes = currencies.rows.map((c) => c.code).join(", ");
  return { ok: false, message: `I don't see a "${currency}" currency in this workspace. Available: ${codes || "(none configured)"}.` };
}

/**
 * Typed client workflows (goclmcp §2.4). Reads + create execute immediately;
 * update/delete are risky and preview→commit. All gated by `work_structure`.
 * `delete` archives then deletes, and surfaces Clockify's error if the client
 * still has active projects.
 */

const WORK = "work_structure" as const;
const clientCreateContract = durableMutationContract({
  source: "safe",
  targeting: { mode: "create_no_target" },
  strategies: ["create", "update"],
  unreconciledStepIds: ["create-client"],
});

type ClientCreateOperation = {
  base: { name: string };
  enrichment: { ccEmails?: string[]; currencyId?: string };
  beforeIds: string[];
};

async function reconcileCreatedClient(
  ctx: ActionContext,
  beforeIds: readonly string[],
  expected: Record<string, unknown>,
) {
  const after = await ctx.clockify.listClients({ archived: false });
  if (after.truncated) return undefined;
  const before = new Set(beforeIds);
  const candidates = after.rows.filter((row) => !before.has(row.id) && row.name === expected.name);
  const matches = [];
  for (const candidate of candidates) {
    const raw = await ctx.clockify.getClientMutationState(candidate.id);
    if (raw && Object.entries(expected).every(([key, value]) => JSON.stringify(raw[key]) === JSON.stringify(value))) {
      matches.push(candidate);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function prepareClientCreate(
  ctx: ActionContext,
  args: { name: string; ccEmails?: string[]; currency?: string },
) {
  let currencyId: string | undefined;
  if (args.currency !== undefined) {
    const cur = await resolveCurrencyId(ctx, args.currency);
    if (!cur.ok) return { kind: "clarify" as const, clarify: cur.message };
    currencyId = cur.id;
  }
  const baseline = await ctx.clockify.listClients({ archived: false });
  if (baseline.truncated) {
    return {
      kind: "clarify" as const,
      clarify: "Clockify returned an incomplete client list, so I can't establish a safe create baseline. Narrow the client list or retry when a complete list is available.",
    };
  }
  const enrichment = {
    ...(args.ccEmails !== undefined ? { ccEmails: args.ccEmails } : {}),
    ...(currencyId !== undefined ? { currencyId } : {}),
  };
  const hasEnrichment = Object.keys(enrichment).length > 0;
  return {
    operation: {
      base: { name: args.name },
      enrichment,
      beforeIds: baseline.rows.map((row) => row.id).sort(),
    } satisfies ClientCreateOperation,
    mutationPlan: {
      mode: hasEnrichment ? "curated" as const : "single" as const,
      steps: [
        {
          id: "create-client",
          kind: "primary" as const,
          ...(hasEnrichment ? {} : { reconciliationStrategy: "create" as const }),
        },
        ...(hasEnrichment
          ? [{ id: "enrich-client", kind: "primary" as const, reconciliationStrategy: "update" as const }]
          : []),
      ],
    },
  };
}

async function executeClientCreate(
  ctx: ActionContext,
  prepared: PreparedSafeWrite,
): Promise<CommitResult> {
  const payload = prepared.operation as ClientCreateOperation;
  const operation = {
    operationId: ctx.mutationJournal?.operationId ?? "direct:clockify_clients_create",
    actionName: "clockify_clients_create",
    featureGroup: WORK,
    risks: ["safe_write" as const],
    payload: payload as unknown as Record<string, unknown>,
    mutationPlan: prepared.mutationPlan,
  };
  const hasEnrichment = Object.keys(payload.enrichment).length > 0;
  let created: Awaited<ReturnType<typeof ctx.clockify.createClientBaseAtomic>> | undefined;
  const createStep = await executeDurableRiskyStep({
    ctx,
    operation,
    planStepId: "create-client",
    index: 0,
    name: "Create client",
    preparedDetail: { beforeIds: payload.beforeIds, base: payload.base },
    dispatch: async () => {
      const freshBaseline = await ctx.clockify.listClients({ archived: false });
      const freshBeforeIds = freshBaseline.rows.map((row) => row.id).sort();
      if (freshBaseline.truncated ||
        sanitizedFingerprint(freshBeforeIds) !== sanitizedFingerprint(payload.beforeIds)) {
        throw new DefinitiveWriteFailure(
          "VERIFY",
          "client_create_baseline",
          "The complete client baseline changed immediately before create. No client was created.",
        );
      }
      const result = hasEnrichment
        ? { value: await ctx.clockify.createClientBaseAtomic(payload.base), reconciled: false }
        : await dispatchWithReconciliation({
            dispatch: () => ctx.clockify.createClientBaseAtomic(payload.base),
            reconcile: () => reconcileCreatedClient(ctx, freshBeforeIds, payload.base),
          });
      created = result.value;
      return {
        externalId: result.value.id,
        effect: { created: { type: "client", id: result.value.id, name: result.value.name } },
        detail: { reconciled: result.reconciled, baselineComplete: true },
      };
    },
  });
  if (createStep.status === "outcome_unknown") {
    return errorReceipt({
      action: operation.actionName,
      code: "commit_outcome_unknown",
      message: "Client creation may or may not have applied. No enrichment update was dispatched.",
      recovery: { hint: "Verify the client list before deciding whether to retry.", retryable: false },
    });
  }
  if (createStep.status === "definitive_failed") {
    return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Clockify rejected client creation." });
  }
  if (!created) throw new Error("created_client_missing");
  const createdRef = { type: "client", id: created.id, name: created.name };
  if (isJournalDegradedStep(createStep)) {
    return {
      kind: "partial",
      receipt: successReceipt({ action: operation.actionName, entity: "client", changed: { created: [createdRef] } }),
      message: "The client was created, but the durable step record degraded, so enrichment was not dispatched.",
      recovery: { hint: "Refresh the client and apply any missing billing fields manually.", retryable: false },
    };
  }
  if (!hasEnrichment) {
    return successReceipt({
      action: operation.actionName,
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [createdRef] },
    });
  }

  const body = await ctx.clockify.prepareClientUpdate(created.id, payload.enrichment);
  const enrichmentStep = await executeDurableRiskyStep({
    ctx,
    operation,
    planStepId: "enrich-client",
    index: 1,
    name: "Enrich client",
    preparedDetail: { clientId: created.id, body },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: () => ctx.clockify.updateClientAtomic(created!.id, body),
        reconcile: async () => {
          const raw = await ctx.clockify.getClientMutationState(created!.id);
          return raw && Object.entries(payload.enrichment).every(([key, value]) => JSON.stringify(raw[key]) === JSON.stringify(value))
            ? created
            : undefined;
        },
      });
      return {
        externalId: created!.id,
        effect: { enriched: { type: "client", id: created!.id } },
        detail: { reconciled: result.reconciled },
      };
    },
  });
  if (enrichmentStep.status === "succeeded" && !isJournalDegradedStep(enrichmentStep)) {
    return successReceipt({
      action: operation.actionName,
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [createdRef] },
    });
  }
  if (enrichmentStep.status === "outcome_unknown") {
    return errorReceipt({
      action: operation.actionName,
      code: "commit_outcome_unknown",
      message: "The client was created, but its billing enrichment outcome is unknown.",
      recovery: { hint: "Inspect the client's billing fields before any retry.", retryable: false },
    });
  }
  return {
    kind: "partial",
    receipt: successReceipt({ action: operation.actionName, entity: "client", changed: { created: [createdRef] } }),
    message: isJournalDegradedStep(enrichmentStep)
      ? "The client and billing enrichment succeeded, but the durable enrichment record degraded."
      : "The client was created, but Clockify rejected its billing enrichment.",
    recovery: { hint: "Refresh the client and apply the missing billing fields manually if needed.", retryable: false },
  };
}

const listClients = defineReadAction({
  name: "clockify_clients_list",
  description: "List clients (optional name / archived filter).",
  group: WORK,
  schema: z.object({ name: z.string().optional(), archived: z.boolean().optional() }),
  async handler(ctx, args) {
    const { rows, truncated } = await ctx.clockify.listClients(args);
    return listReceipt({
      action: "clockify_clients_list",
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
    });
  },
});

const getClient = defineAction({
  name: "clockify_clients_get",
  description: "Fetch a single client by id, or by its exact `name` (resolved server-side).",
  featureGroup: WORK,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the client id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "client",
      verb: "fetch",
      list: () => ctx.clockify.listClients(),
    });
    if (!resolved.ok) {
      return { kind: "clarify", message: resolved.clarify.clarify, options: resolved.clarify.options };
    }
    const entity = await ctx.clockify.getClient(resolved.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_clients_get",
        entity: "client",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const createClient = defineAction({
  name: "clockify_clients_create",
  description:
    'Create a client (optional billing `ccEmails` + `currency` by code, e.g. "EUR", or exact currency id). Safe write — executes immediately when policy allows.',
  featureGroup: WORK,
  risks: ["safe_write"],
  mutationWorkflow: "durable",
  mutationContract: clientCreateContract,
  schema: z.object({
    name: z.string().min(1),
    ccEmails: z.array(z.string().email()).optional(),
    /** Currency code (e.g. "USD") or exact id, resolved server-side. */
    currency: z.string().min(1).optional(),
  }),
  prepareSafeWrite: prepareClientCreate,
  executeSafeWrite: executeClientCreate,
  async handler(ctx, args): Promise<ActionResult> {
    const prepared = await prepareClientCreate(ctx, args);
    if (isSafeWriteClarification(prepared)) return clarifyResult(prepared);
    if (!isPreparedSafeWrite(prepared)) {
      return { kind: "receipt", receipt: errorReceipt({ action: "clockify_clients_create", code: "invalid_safe_write_preparation", message: "Client create preparation failed." }) };
    }
    const result = await executeClientCreate(ctx, prepared);
    return isPartialCommitResult(result) ? result : { kind: "receipt", receipt: result };
  },
});

const updateClient = defineRiskyAction({
  name: "clockify_clients_update",
  description:
    'Update a client (rename, archive/unarchive, set billing `ccEmails`, set `currency` by code e.g. "EUR" or exact id). Pass the client\'s `id`, or its exact `currentName` and the harness resolves it — use this to RENAME (`currentName` + the new `name`) without listing first. Elevated write — previews and requires confirmation.',
  group: WORK,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["update"] }),
  argumentOpenPaths: ["fields"],
  schema: z
    .object({
      id: z.string().min(1).optional(),
      /** The client's existing name, resolved to an id server-side (rename-by-name). */
      currentName: z.string().min(1).optional(),
      name: z.string().optional(),
      archived: z.boolean().optional(),
      /** Billing CC recipients (Clockify `ccEmails`); update sticks via getThenPut. */
      ccEmails: z.array(z.string().email()).optional(),
      /** Currency code (e.g. "EUR") or exact id, resolved server-side. */
      currency: z.string().min(1).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((v) => v.id !== undefined || v.currentName !== undefined, {
      message: "Provide the client id or its exact currentName.",
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.archived !== undefined ||
        v.ccEmails !== undefined ||
        v.currency !== undefined ||
        v.fields !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(
      { id: args.id, name: args.currentName },
      {
        noun: "client",
        verb: "update",
        list: (filter) => ctx.clockify.listClients(filter),
        // Unarchiving targets an entity that is archived by definition.
        includeArchived: args.archived === false,
        verifyId: true,
      },
    );
    if (!resolved.ok) return resolved.clarify;
    let currencyId: string | undefined;
    if (args.currency !== undefined) {
      const cur = await resolveCurrencyId(ctx, args.currency);
      if (!cur.ok) return { clarify: cur.message };
      currencyId = cur.id;
    }
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {}),
      ...(args.ccEmails !== undefined ? { ccEmails: args.ccEmails } : {}),
      ...(currencyId !== undefined ? { currencyId } : {}),
      ...(args.fields ?? {}),
    };
    const current = await ctx.clockify.getClient(resolved.id);
    if (!current) return { clarify: "The requested client no longer exists. Refresh and try again." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "target", "client", current);
    const body = await ctx.clockify.prepareClientUpdate(resolved.id, patch);
    return {
      actionLabel: "Update client",
      targets: [{ type: "client", id: resolved.id, name: resolved.name ?? args.name }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the client again to revert most fields.",
      warnings: ["Updating a client changes live workspace data."],
      payload: { id: resolved.id, patch, body },
      targetSnapshots: [targetSnapshot],
      mutationPlan: mutationPlan([{ id: "update-client", strategy: "update", fingerprint: targetSnapshot.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
    const { id, body } = payload as { id: string; body: Record<string, unknown> };
    let updated: Awaited<ReturnType<typeof ctx.clockify.getClient>>;
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-client", name: "Update client",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.updateClientAtomic(id, body),
          reconcile: async () => {
            const raw = await ctx.clockify.getClientMutationState(id);
            return raw && sanitizedFingerprint(raw) === sanitizedFingerprint(body)
              ? raw as unknown as Awaited<ReturnType<typeof ctx.clockify.updateClientAtomic>>
              : undefined;
          },
        });
        updated = result.value;
        return { externalId: result.value.id, effect: { updated: { type: "client", id } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_clients_update", entity: "client", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "client", id, name: updated?.name }] } }),
    });
  },
});

const deleteClient = defineRiskyAction({
  name: "clockify_clients_delete",
  description:
    "Delete a client (archives first, then deletes). Pass the client id, or its exact `name` and the harness resolves it. Fails if the client still has active projects. Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["state-command", "delete", "update"] }),
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the client id or its exact name.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "client",
      verb: "delete",
      list: (filter) => ctx.clockify.listClients(filter),
      // Deleting an ARCHIVED client is valid (delete archives first anyway).
      includeArchived: true,
      verifyId: true,
    });
    if (!resolved.ok) return resolved.clarify;
    const name = resolved.name ?? args.name;
    const current = await ctx.clockify.getClient(resolved.id);
    if (!current) return { clarify: "The requested client no longer exists. Refresh and try again." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "target", "client", current);
    const changedArchiveState = current.archived !== true;
    const archiveBody = changedArchiveState
      ? await ctx.clockify.prepareClientUpdate(resolved.id, { archived: true })
      : undefined;
    const restoreBody = changedArchiveState
      ? await ctx.clockify.prepareClientUpdate(resolved.id, { archived: false })
      : undefined;
    const transitionedTargetFingerprint = changedArchiveState
      ? snapshot("target", "client", current, archiveBody).fingerprint
      : targetSnapshot.fingerprint;
    const steps = changedArchiveState
      ? [
          { id: "archive-client", strategy: "state-command" as const, fingerprint: targetSnapshot.fingerprint },
          { id: "delete-client", strategy: "delete" as const, fingerprint: transitionedTargetFingerprint },
          { id: "restore-client", kind: "compensation" as const, strategy: "update" as const, fingerprint: transitionedTargetFingerprint },
        ]
      : [{ id: "delete-client", strategy: "delete" as const, fingerprint: targetSnapshot.fingerprint }];
    return {
      actionLabel: "Delete client",
      targets: [{ type: "client", id: resolved.id, name }],
      expectedChanges: [`Delete client ${name ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: [
        "Deleting a client is permanent.",
        "Clockify rejects this if the client still has active projects.",
      ],
      payload: { id: resolved.id, name, originalArchived: current.archived === true, archiveBody, restoreBody, transitionedTargetFingerprint },
      targetSnapshots: [targetSnapshot],
      mutationPlan: mutationPlan(steps),
    };
  },
  async commit(ctx, payload, operation): Promise<CommitResult> {
    const { id, name, originalArchived, archiveBody, restoreBody, transitionedTargetFingerprint } = payload as {
      id: string; name?: string; originalArchived: boolean; archiveBody?: Record<string, unknown>; restoreBody?: Record<string, unknown>; transitionedTargetFingerprint: string;
    };
    let archiveStep: Awaited<ReturnType<typeof executeDurableRiskyStep>> | undefined;
    let index = 0;
    if (!originalArchived) {
      archiveStep = await executeDurableRiskyStep({
        ctx, operation, planStepId: "archive-client", index, name: "Archive client",
        dispatch: async () => {
          await requireFreshSnapshots(ctx, operation.targetSnapshots ?? []);
          const result = await dispatchWithReconciliation({
            dispatch: () => ctx.clockify.updateClientAtomic(id, archiveBody!),
            reconcile: async () => { const row = await ctx.clockify.getClient(id); return row?.archived === true ? row : undefined; },
          });
          return { externalId: result.value.id, effect: { archived: { type: "client", id } }, detail: { reconciled: result.reconciled } };
        },
      });
      index += 1;
      if (archiveStep.status === "outcome_unknown") return errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: "Client archive outcome is unknown; delete was not dispatched.", recovery: { hint: "Refresh the client before trying again.", retryable: false } });
      if (archiveStep.status === "definitive_failed") return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Clockify rejected the client archive; delete was not dispatched." });
      if (isJournalDegradedStep(archiveStep)) return { kind: "partial", receipt: successReceipt({ action: operation.actionName, entity: "client", changed: { updated: [{ type: "client", id, name }] } }), message: "The client was archived, but local settlement degraded, so delete was not dispatched.", recovery: { hint: "Refresh the client and review it manually.", retryable: false } };
    }
    const beforeDelete = await ctx.clockify.getClient(id);
    if (!beforeDelete || beforeDelete.archived !== true) return errorReceipt({ action: operation.actionName, code: "stale_target", message: "The client was not authoritatively archived immediately before delete. No delete was sent.", recovery: { hint: "Create a fresh preview.", retryable: true } });
    const deleteSnapshot = await captureStructureSnapshot(ctx, "target", "client", beforeDelete);
    if (deleteSnapshot.fingerprint !== transitionedTargetFingerprint) return errorReceipt({ action: operation.actionName, code: "stale_target", message: "The archived client changed before delete. No delete was sent.", recovery: { hint: "Create a fresh preview.", retryable: true } });
    const deleted = await executeDurableRiskyStep({
      ctx, operation, planStepId: "delete-client", index, name: "Delete client",
      dispatch: async () => {
        await requireFreshSnapshots(ctx, [deleteSnapshot]);
        const result = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.deleteClientAtomic(id); return true as const; },
          reconcile: () => reconcileDelete(() => ctx.clockify.getClient(id)),
        });
        return { effect: { deleted: { type: "client", id } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (deleted.status === "succeeded") return successReceipt({ action: operation.actionName, entity: "client", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "client", id, name }] } });
    if (deleted.status === "outcome_unknown") return errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: "Client delete outcome is unknown. Archive compensation was not attempted.", recovery: { hint: "Verify whether the client exists before any retry.", retryable: false } });
    if (!archiveStep || !restoreBody) return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Clockify rejected deletion of the already-archived client." });
    if (!ctx.mutationJournal) {
      return { kind: "partial", receipt: successReceipt({ action: operation.actionName, entity: "client", changed: { updated: [{ type: "client", id, name }] } }), message: "Client archive succeeded and delete failed; durable compensation was unavailable, so no restore mutation was sent.", recovery: { hint: "Inspect the client archive state manually.", retryable: false } };
    }
    const compensation = await executeCompensationStep({
      journal: ctx.mutationJournal, operationId: operation.operationId,
      step: { id: "restore-client", index: index + 1, name: "Restore client archive state", kind: "compensation", compensatesStepId: archiveStep.id, targetFingerprint: transitionedTargetFingerprint },
      dispatch: async () => {
        const current = await ctx.clockify.getClient(id);
        if (!current || current.archived !== true) throw new Error("client_compensation_target_unknown");
        const currentSnapshot = await captureStructureSnapshot(ctx, "target", "client", current);
        if (currentSnapshot.fingerprint !== transitionedTargetFingerprint) throw new DefinitiveWriteFailure("VERIFY", "stale_target", "Client changed before compensation.");
        const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.updateClientAtomic(id, restoreBody), reconcile: async () => { const row = await ctx.clockify.getClient(id); return row?.archived === false ? row : undefined; } });
        return { externalId: result.value.id, effect: { restoredArchiveState: { type: "client", id } }, detail: { reconciled: result.reconciled } };
      },
    });
    const compensationStatus = compensation.status;
    if (compensationStatus === "compensated") return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Client deletion was rejected; the archive state was restored." });
    return { kind: "partial", receipt: successReceipt({ action: operation.actionName, entity: "client", changed: { updated: [{ type: "client", id, name }] } }), message: "Client archive succeeded and delete failed; restoring the original state did not complete definitively.", recovery: { hint: "Inspect the client archive state manually.", retryable: false } };
  },
});

export const CLIENT_ACTIONS: ActionDefinition[] = [
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
];
