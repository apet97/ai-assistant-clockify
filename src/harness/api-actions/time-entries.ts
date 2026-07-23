import { type ActionDefinition } from "../action.js";
import { defineDurableSafeWriteAction } from "../durable-safe-write.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { defineStructureDurableSafeWriteAction } from "../workflows/structure-durable.js";
import { ENTRY_API_METADATA } from "../workflows/entry-api-metadata.js";
import {
  TIME_ENTRY_BILLABLE_LITERAL_ALIASES,
  dispatchEntriesCreate,
  dispatchEntriesStart,
  entriesCreateSchema,
  entriesStartSchema,
  prepareEntriesCreate,
  prepareEntriesCreateDispatch,
  prepareEntriesStart,
} from "../workflows/entry-action-shared.js";

const TIME = "time_tracking" as const;

const createDefinition = defineStructureDurableSafeWriteAction({
  ...ENTRY_API_METADATA.clockify_entries_create,
  name: "clockify_entries_create",
  description:
    "Log a completed time entry with one POST /time-entries. Resolves project/task by name server-side. Use exactly one shape: `start+end`, `start+durationHours|durationMinutes`, or `date|dayOffset + durationHours|durationMinutes`. Up to 14 tag ids/names in `tagIds`. Safe write — executes immediately when policy allows.",
  group: TIME,
  stepName: "Create time entry",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["create"],
  }),
  semanticLiteralAliases: TIME_ENTRY_BILLABLE_LITERAL_ALIASES,
  schema: entriesCreateSchema,
  prepare: prepareEntriesCreate,
  prepareDispatch: prepareEntriesCreateDispatch,
  dispatch: (ctx, operation, state) => dispatchEntriesCreate(ctx, operation, state, "clockify_entries_create"),
});

const create = Object.freeze({ ...createDefinition });

const start = defineDurableSafeWriteAction({
  name: "clockify_entries_start",
  ...ENTRY_API_METADATA.clockify_entries_start,
  description:
    "Start a running timer with one POST /time-entries (start only). Pass the project/task by name — resolved server-side; unknown names clarify. Up to 14 tag ids/names in `tagIds`. Safe write — executes immediately when policy allows.",
  group: TIME,
  stepName: "Start time entry",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["create"],
  }),
  semanticLiteralAliases: TIME_ENTRY_BILLABLE_LITERAL_ALIASES,
  schema: entriesStartSchema,
  prepare: prepareEntriesStart,
  dispatch: (ctx, operation) => dispatchEntriesStart(ctx, operation, "clockify_entries_start"),
});

export const ENTRY_API_ACTIONS: ActionDefinition[] = [
  create,
  start,
];
