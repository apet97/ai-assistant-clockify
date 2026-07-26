import { z } from "zod";
import { defineRiskyAction, type ActionDefinition } from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { defineStructureDurableSafeWriteAction, dispatchWithReconciliation, mutationPlan } from "../workflows/structure-durable.js";
import { successReceipt } from "../receipts.js";
import { STRUCTURE_API_METADATA } from "../workflows/structure-api-metadata.js";
import {
  commitDeleteArchivedClient,
  previewDeleteArchivedClient,
  clientTargetRefSchema,
  reconcileCreatedClient,
} from "../workflows/client-action-shared.js";

const WORK = "work_structure" as const;

const createBaseDefinition = defineStructureDurableSafeWriteAction({
  ...STRUCTURE_API_METADATA.clockify_clients_create_base,
  name: "clockify_clients_create_base",
  description:
    'Create a client with only its name (POST /clients). Billing fields such as ccEmails and currency are silently dropped on create — apply them afterward with clockify_clients_update. Safe write — executes immediately when policy allows.',
  group: WORK,
  stepName: "Create client",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "create_no_target" },
    strategies: ["create"],
  }),
  schema: z.object({
    name: z.string().min(1),
  }),
  async prepare(ctx, args) {
    const baseline = await ctx.clockify.listClients({ archived: false });
    if (baseline.truncated) {
      return {
        kind: "clarify" as const,
        clarify: "Clockify returned an incomplete client list, so I can't establish a safe create baseline. Narrow the client list or retry when a complete list is available.",
      };
    }
    return {
      operation: { body: { name: args.name }, beforeIds: baseline.rows.map((row) => row.id).sort() },
      mutationPlan: mutationPlan([{ id: "create-client-base", strategy: "create" }]),
    };
  },
  async prepareDispatch(_ctx, operation) {
    const { beforeIds } = operation as { beforeIds: string[] };
    return {
      preparedDetail: { beforeIds, base: (operation as { body: { name: string } }).body },
      state: { beforeIds },
    };
  },
  async dispatch(ctx, operation, state) {
    const { body } = operation as { body: { name: string } };
    const result = await dispatchWithReconciliation({
      dispatch: () => ctx.clockify.createClientBaseAtomic(body),
      reconcile: () => reconcileCreatedClient(ctx, state.beforeIds, body),
    });
    const client = result.value;
    const created = { type: "client", id: client.id, name: client.name };
    return {
      result: successReceipt({
        action: "clockify_clients_create_base",
        entity: "client",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [created] },
      }),
      externalId: client.id,
      effect: { created },
      detail: { reconciled: result.reconciled, baselineComplete: true },
    };
  },
});

const createBase = Object.freeze({ ...createBaseDefinition });

const deleteArchived = defineRiskyAction({
  name: "clockify_clients_delete_archived",
  ...STRUCTURE_API_METADATA.clockify_clients_delete_archived,
  description:
    "Delete an already-archived client with a single DELETE (Clockify rejects deleting an active client). Pass the client id or its exact name. Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["delete"] }),
  schema: clientTargetRefSchema,
  referenceSelector: {
    entityType: "client",
    bindings: [{ referenceField: "externalId", argumentPath: "/id" }],
  },
  preview: (ctx, args) => previewDeleteArchivedClient(ctx, args),
  commit: (ctx, payload, operation) => commitDeleteArchivedClient(ctx, payload, operation, "clockify_clients_delete_archived"),
});

export const CLIENT_API_ACTIONS: ActionDefinition[] = [
  createBase,
  deleteArchived,
];
