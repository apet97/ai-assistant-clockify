import { z } from "zod";
import type {
  ActionContext,
  CommitResult,
  ConfirmableOperation,
  RiskyClarifyResult,
  RiskyPreviewResult,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { describePatch, resolveEntityRef } from "./resolve.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import {
  captureStructureSnapshot,
  dispatchWithReconciliation,
  fetchStructureSnapshot,
  mutationPlan,
  reconcileCreate,
  reconcileDelete,
  requireFreshSnapshots,
} from "./structure-durable.js";
import { sanitizedFingerprint } from "../safe-json.js";

/** Resolve a currency code or exact id to its workspace currencyId, or clarify. */
export async function resolveCurrencyId(
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

export async function reconcileCreatedClient(
  ctx: ActionContext,
  beforeIds: readonly string[],
  expected: { name: string },
) {
  return reconcileCreate({
    beforeIds,
    list: () => ctx.clockify.listClients({ archived: false }),
    matches: (row) => row.name === expected.name,
  });
}

export const clientClosedUpdateSchema = z
  .object({
    id: z.string().min(1).optional(),
    currentName: z.string().min(1).optional(),
    name: z.string().optional(),
    archived: z.boolean().optional(),
    ccEmails: z.array(z.string().email()).optional(),
    currency: z.string().min(1).optional(),
  })
  .refine((v) => v.id !== undefined || v.currentName !== undefined, {
    message: "Provide the client id or its exact currentName.",
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.archived !== undefined ||
      v.ccEmails !== undefined ||
      v.currency !== undefined,
    { message: "Provide at least one field to change." },
  );

export const clientTargetRefSchema = z
  .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
  .refine((v) => v.id !== undefined || v.name !== undefined, {
    message: "Provide the client id or its exact name.",
  });

export async function previewClientClosedUpdate(
  ctx: ActionContext,
  args: z.infer<typeof clientClosedUpdateSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveEntityRef(
    { id: args.id, name: args.currentName },
    {
      noun: "client",
      verb: "update",
      list: (filter) => ctx.clockify.listClients(filter),
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
}

export async function commitClientClosedUpdate(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
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
    success: () => successReceipt({
      action: actionName,
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "client", id, name: updated?.name }] },
    }),
  });
}

export async function previewArchiveClient(
  ctx: ActionContext,
  args: z.infer<typeof clientTargetRefSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveEntityRef(args, {
    noun: "client",
    verb: "archive",
    list: (filter) => ctx.clockify.listClients(filter),
    includeArchived: true,
    verifyId: true,
  });
  if (!resolved.ok) return resolved.clarify;
  const name = resolved.name ?? args.name;
  const current = await ctx.clockify.getClient(resolved.id);
  if (!current) return { clarify: "The requested client no longer exists. Refresh and try again." };
  const targetSnapshot = await captureStructureSnapshot(ctx, "target", "client", current);
  const body = await ctx.clockify.prepareClientUpdate(resolved.id, { archived: true });
  return {
    actionLabel: "Archive client",
    targets: [{ type: "client", id: resolved.id, name }],
    expectedChanges: [`Archive client ${name ?? resolved.id}`],
    reversibility: "Archiving is reversible — you can unarchive the client later.",
    warnings: ["Archiving hides the client from active workflows."],
    payload: { id: resolved.id, name, body },
    targetSnapshots: [targetSnapshot],
    mutationPlan: mutationPlan([{ id: "archive-client", strategy: "state-command", fingerprint: targetSnapshot.fingerprint }]),
  };
}

export async function commitArchiveClient(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { id, body } = payload as { id: string; body: Record<string, unknown> };
  let archived: Awaited<ReturnType<typeof ctx.clockify.getClient>>;
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "archive-client", name: "Archive client",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: () => ctx.clockify.archiveClientAtomic(id, body),
        reconcile: async () => { const row = await ctx.clockify.getClient(id); return row?.archived === true ? row : undefined; },
      });
      archived = result.value;
      return { externalId: result.value.id, effect: { archived: { type: "client", id } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "client", id, name: archived?.name }] },
    }),
  });
}

export async function previewDeleteArchivedClient(
  ctx: ActionContext,
  args: z.infer<typeof clientTargetRefSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveEntityRef(args, {
    noun: "client",
    verb: "delete",
    list: (filter) => ctx.clockify.listClients(filter),
    includeArchived: true,
    verifyId: true,
  });
  if (!resolved.ok) return resolved.clarify;
  const name = resolved.name ?? args.name;
  const current = await ctx.clockify.getClient(resolved.id);
  if (!current) return { clarify: "The requested client no longer exists. Refresh and try again." };
  if (current.archived !== true) {
    return {
      clarify: `Client "${name ?? resolved.id}" is still active — archive it first, or use clockify_clients_delete to archive and delete in one confirmation.`,
    };
  }
  const targetSnapshot = await captureStructureSnapshot(ctx, "target", "client", current);
  return {
    actionLabel: "Delete archived client",
    targets: [{ type: "client", id: resolved.id, name }],
    expectedChanges: [`Delete archived client ${name ?? resolved.id}`],
    reversibility: "This cannot be undone.",
    warnings: [
      "Deleting a client is permanent.",
      "Clockify rejects this if the client still has active projects.",
    ],
    payload: { id: resolved.id, name },
    targetSnapshots: [targetSnapshot],
    mutationPlan: mutationPlan([{ id: "delete-archived-client", strategy: "delete", fingerprint: targetSnapshot.fingerprint }]),
  };
}

export async function commitDeleteArchivedClient(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { id, name } = payload as { id: string; name?: string };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "delete-archived-client", name: "Delete archived client",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      await requireFreshSnapshots(ctx, operation.targetSnapshots ?? []);
      const beforeDelete = await ctx.clockify.getClient(id);
      if (!beforeDelete || beforeDelete.archived !== true) {
        throw new Error("stale_target");
      }
      const result = await dispatchWithReconciliation({
        dispatch: async () => { await ctx.clockify.deleteClientAtomic(id); return true as const; },
        reconcile: () => reconcileDelete(() => ctx.clockify.getClient(id)),
      });
      return { effect: { deleted: { type: "client", id } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "client", id, name }] },
    }),
  });
}
