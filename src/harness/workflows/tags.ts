import { z } from "zod";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { defineDurableSafeWriteAction } from "../durable-safe-write.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { describePatch, resolveEntityRef } from "./resolve.js";
import { captureStructureSnapshot, dispatchWithReconciliation, fetchStructureSnapshot, mutationPlan, reconcileCreate, reconcileDelete } from "./structure-durable.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { sanitizedFingerprint } from "../safe-json.js";

/**
 * Typed tag workflows (goclmcp §2.5). Reads + create execute immediately;
 * update/delete are risky and preview→commit. All gated by `work_structure`.
 */

const WORK = "work_structure" as const;

const listTags = defineReadAction({
  name: "clockify_tags_list",
  description: "List tags (optional name / archived filter).",
  group: WORK,
  schema: z.object({ name: z.string().optional(), archived: z.boolean().optional() }),
  async handler(ctx, args) {
    const { rows, truncated } = await ctx.clockify.listTags(args);
    return listReceipt({
      action: "clockify_tags_list",
      entity: "tag",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
    });
  },
});

const getTag = defineAction({
  name: "clockify_tags_get",
  description: "Fetch a single tag by id, or by its exact `name` (resolved server-side).",
  featureGroup: WORK,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the tag id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "tag",
      verb: "fetch",
      list: () => ctx.clockify.listTags(),
    });
    if (!resolved.ok) {
      return { kind: "clarify", message: resolved.clarify.clarify, options: resolved.clarify.options };
    }
    const entity = await ctx.clockify.getTag(resolved.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_tags_get",
        entity: "tag",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const createTag = defineDurableSafeWriteAction({
  name: "clockify_tags_create",
  description: "Create a tag. Safe write — executes immediately when policy allows.",
  group: WORK,
  stepName: "Create tag",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "create_no_target" },
    strategies: ["create"],
  }),
  schema: z.object({ name: z.string().trim().min(1) }),
  async prepare(ctx, args) {
    const baseline = await ctx.clockify.listTags({ archived: false });
    if (baseline.truncated) {
      return {
        kind: "clarify" as const,
        clarify: "Clockify returned an incomplete tag list, so I can't establish a safe create baseline. Narrow the tag list or retry when a complete list is available.",
      };
    }
    return {
      operation: { body: { name: args.name }, beforeIds: baseline.rows.map((row) => row.id).sort() },
      mutationPlan: { mode: "single", steps: [{ id: "create-tag", kind: "primary", reconciliationStrategy: "create" }] },
    };
  },
  async dispatch(ctx, operation) {
    const { body, beforeIds } = operation as { body: { name: string }; beforeIds: string[] };
    const freshBaseline = await ctx.clockify.listTags({ archived: false });
    const freshBeforeIds = freshBaseline.rows.map((row) => row.id).sort();
    if (freshBaseline.truncated ||
      sanitizedFingerprint(freshBeforeIds) !== sanitizedFingerprint(beforeIds)) {
      throw new DefinitiveWriteFailure(
        "VERIFY",
        "tag_create_baseline",
        "The complete tag baseline changed immediately before create. No tag was created.",
      );
    }
    const dispatched = await dispatchWithReconciliation({
      dispatch: () => ctx.clockify.createTag(body),
      reconcile: () => reconcileCreate({
        beforeIds: freshBeforeIds,
        list: () => ctx.clockify.listTags({ archived: false }),
        matches: (row) => row.name === body.name,
      }),
    });
    const tag = dispatched.value;
    const created = { type: "tag", id: tag.id, name: tag.name };
    return {
      result: successReceipt({
        action: "clockify_tags_create",
        entity: "tag",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [created] },
      }),
      externalId: tag.id,
      effect: { created },
      detail: { reconciled: dispatched.reconciled, baselineComplete: true },
    };
  },
});

const updateTag = defineRiskyAction({
  name: "clockify_tags_update",
  description:
    "Update a tag (rename, archived). Pass the tag's `id`, or its exact `currentName` and the harness resolves it — use this to RENAME (`currentName` + the new `name`) without listing first. Elevated write — previews and requires confirmation.",
  group: WORK,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["target"] },
    strategies: ["update"],
  }),
  schema: z
    .object({
      id: z.string().min(1).optional(),
      /** The tag's existing name, resolved to an id server-side (rename-by-name). */
      currentName: z.string().min(1).optional(),
      name: z.string().optional(),
      archived: z.boolean().optional(),
    })
    .refine((v) => v.id !== undefined || v.currentName !== undefined, {
      message: "Provide the tag id or its exact currentName.",
    })
    .refine((v) => v.name !== undefined || v.archived !== undefined, {
      message: "Provide at least one field to change.",
    }),
  async preview(ctx, args) {
    // Resolve currentName → id (the delete-by-name pattern, including a name
    // passed in the id slot) so a rename never dead-ends on a missing id.
    // Ambiguous identity stops and asks.
    const resolved = await resolveEntityRef(
      { id: args.id, name: args.currentName },
      {
        noun: "tag",
        verb: "update",
        list: (filter) => ctx.clockify.listTags(filter),
        // Unarchiving targets an entity that is archived by definition.
        includeArchived: args.archived === false,
        verifyId: true,
      },
    );
    if (!resolved.ok) return resolved.clarify;
    const id = resolved.id;
    const targetName = resolved.name ?? args.currentName;
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {}),
    };
    const current = await ctx.clockify.getTag(id);
    if (!current) return { clarify: "The requested tag no longer exists. Refresh and try again." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "target", "tag", current);
    const body = await ctx.clockify.prepareTagUpdate(id, patch);
    return {
      actionLabel: "Update tag",
      targets: [{ type: "tag", id, name: targetName ?? args.name }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the tag again to revert most fields.",
      warnings: ["Updating a tag changes live workspace data."],
      payload: { id, patch, body },
      targetSnapshots: [targetSnapshot],
      mutationPlan: mutationPlan([{ id: "update-tag", strategy: "update", fingerprint: targetSnapshot.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
    const { id, patch, body } = payload as { id: string; patch: Record<string, unknown>; body: Record<string, unknown> };
    let updated: Awaited<ReturnType<typeof ctx.clockify.getTag>>;
    return commitSingleDurableRiskyStep({
      ctx,
      operation,
      planStepId: "update-tag",
      name: "Update tag",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.updateTagAtomic(id, body),
          reconcile: async () => {
            const row = await ctx.clockify.getTag(id);
            if (!row) return undefined;
            return Object.entries(patch).every(([key, value]) => JSON.stringify((row as unknown as Record<string, unknown>)[key]) === JSON.stringify(value)) ? row : undefined;
          },
        });
        updated = result.value;
        return { externalId: result.value.id, effect: { updated: { type: "tag", id } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({
        action: "clockify_tags_update",
        entity: "tag",
        ids: { workspaceId: ctx.workspaceId },
        changed: { updated: [{ type: "tag", id, name: updated?.name }] },
      }),
    });
  },
});

const deleteTag = defineRiskyAction({
  name: "clockify_tags_delete",
  description:
    "Delete a tag. Pass the tag's id (preferred — list tags first to get it), or its exact name and the harness resolves it to an id. Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["target"] },
    strategies: ["delete"],
  }),
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the tag id or its exact name.",
    }),
  async preview(ctx, args) {
    // Resolve a name → id (including a name passed in the id slot), so a delete
    // never dead-ends or commits a doomed id. Ambiguous identity stops and asks.
    const resolved = await resolveEntityRef(args, {
      noun: "tag",
      verb: "delete",
      list: (filter) => ctx.clockify.listTags(filter),
      // Deleting an ARCHIVED tag is valid.
      includeArchived: true,
      verifyId: true,
    });
    if (!resolved.ok) return resolved.clarify;
    const { id } = resolved;
    const name = resolved.name ?? args.name;
    const current = await ctx.clockify.getTag(id);
    if (!current) return { clarify: "The requested tag no longer exists. Refresh and try again." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "target", "tag", current);
    return {
      actionLabel: "Delete tag",
      targets: [{ type: "tag", id, name }],
      expectedChanges: [`Delete tag ${name ?? id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a tag is permanent and removes it from tagged entries."],
      payload: { id, name },
      targetSnapshots: [targetSnapshot],
      mutationPlan: mutationPlan([{ id: "delete-tag", strategy: "delete", fingerprint: targetSnapshot.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
    const { id, name } = payload as { id: string; name?: string };
    return commitSingleDurableRiskyStep({
      ctx,
      operation,
      planStepId: "delete-tag",
      name: "Delete tag",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.deleteTagAtomic(id); return true as const; },
          reconcile: () => reconcileDelete(() => ctx.clockify.getTag(id)),
        });
        return { effect: { deleted: { type: "tag", id } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({
        action: "clockify_tags_delete",
        entity: "tag",
        ids: { workspaceId: ctx.workspaceId },
        changed: { deleted: [{ type: "tag", id, name }] },
      }),
    });
  },
});

export const TAG_ACTIONS: ActionDefinition[] = [listTags, getTag, createTag, updateTag, deleteTag];
