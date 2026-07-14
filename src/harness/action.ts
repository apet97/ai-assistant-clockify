import type { z } from "zod";
import type { AdminPolicy, FeatureGroup } from "./permissions.js";
import type { RiskLabel } from "./risk.js";
import type { EntityRef, ErrorReceipt, RecoveryHint, SuccessReceipt } from "./receipts.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { ActionOutcome } from "../metrics/metrics.js";
import { randomUUID } from "node:crypto";
import type {
  ExternalMutationPlan,
  MutationStepJournal,
} from "./mutation-contract.js";

export type { ExternalMutationPlan } from "./mutation-contract.js";

/**
 * Action contracts and the typed `defineAction` helper. This is a leaf module
 * (it imports no workflows and not the catalog), so workflow modules can import
 * `defineAction` without creating a circular dependency with the catalog.
 */

export interface ActionContext {
  workspaceId: string;
  adminUserId: string;
  policy: AdminPolicy;
  clockify: WorkspaceClient;
  /** Verified Clockify calendar settings; calendar actions fail closed if absent. */
  timeZone?: string;
  /** ISO weekday number (Monday=1 … Sunday=7). */
  weekStartsOn?: number;
  /** Injectable clock for deterministic timestamps in tests. */
  now?: () => Date;
  /** Optional idempotency ledger; when present, confirmed commits dedupe by intent. */
  idempotency?: IdempotencyLedger;
  /**
   * Persist the admin's assistant policy; provided by the route which owns the
   * store, so the permission action's commit can be self-contained.
   */
  savePolicy?(policy: AdminPolicy): void;
  /**
   * Read the caller's OWN audited action outcomes + confirmation statuses since
   * an ISO instant; provided by the route which owns the store. Lets the recap
   * action answer "what did you do / what failed" from the audit log instead of
   * windowed chat memory (live items 304/316: recaps contradicted the log).
   */
  recentOutcomes?(sinceIso?: string): { outcomes: ActionOutcome[]; confirmationStatuses: string[] };
  operationJournal?: {
    prepare(actionName: string, operation: unknown, mutationPlan?: ExternalMutationPlan): string;
    markExecuting(operationId: string): void;
    scope(operationId: string): MutationStepJournal;
    settle(
      operationId: string,
      status: "succeeded" | "partial" | "definitive_failed" | "outcome_unknown",
      result: ActionResult,
    ): void;
  };
  /** Durable host-step capabilities bound to the one operation being executed. */
  mutationJournal?: MutationStepJournal;
  /** Fresh role gate injected by the route; returns an error receipt to block. */
  authorizeWrite?(actionName: string): Promise<ErrorReceipt | undefined>;
  saveArtifact?(input: {
    contentType: string;
    filename: string;
    bytes: Uint8Array;
  }): { id: string; expiresAt: string };
}

/**
 * Idempotency ledger for confirmed (risky) commits (Phase 5): a scoped
 * key → success-receipt store with a time window. Defined here (next to
 * {@link ActionContext}, which references it) rather than in `./idempotency.js`
 * so the dependency runs only idempotency.ts → action.ts — no type cycle. Only
 * SUCCESSFUL commits are recorded, so a failed attempt can still be retried.
 */
export interface IdempotencyLedger {
  /** Prior success receipt for this scoped key within the window, else undefined. */
  lookup(scopedKey: string): SuccessReceipt | undefined;
  /** Record a successful commit under this scoped key. */
  record(scopedKey: string, receipt: SuccessReceipt): void;
}

/** Outcome of an atomic claim: this caller won the claim, found a completed
 *  receipt to replay, found a live in-flight claim held by another request, or
 *  found a crash-orphaned claim within the dedup window whose host-side outcome
 *  is UNKNOWN (a prior commit died between the host write and fill) — which must
 *  never be silently re-committed (crash-before-fill residual). */
export type ClaimState = "won" | "replay" | "in_flight" | "stale_unknown";

/**
 * Atomic-claim extension of {@link IdempotencyLedger} (r1-concurrency-races-01).
 * The ledger becomes the cross-row SERIALIZATION point: `claim` is taken BEFORE
 * the commit await, so two concurrent confirms of one intent can't both reach
 * the host. The winner `fill`s on success or `release`s on failure/throw; the
 * loser reads the three-state machine via `claim`/`lookupCompleted`. All three
 * methods are REQUIRED together — a partial ledger falls back to the legacy
 * lookup→await→record path (see {@link isAtomicLedger}).
 */
export interface AtomicIdempotencyLedger extends IdempotencyLedger {
  /** Atomically claim the key (taken BEFORE the commit await). */
  claim(scopedKey: string): ClaimState;
  /** Read the completed receipt for a key the claim reported as `replay`. */
  lookupCompleted(scopedKey: string): CommitResult | undefined;
  /** Complete the OWN claim with its canonical terminal commit result. */
  fill(scopedKey: string, receipt: CommitResult): void;
  /** Release the OWN claim (commit failed/threw) so a retry can re-claim. */
  release(scopedKey: string): void;
  /**
   * Heartbeat: refresh the OWN live claim's timestamp during a long commit so
   * the dead-claim sweep can't fire on a still-in-flight multi-call commit and
   * let a concurrent re-confirm double-commit. Optional — a ledger without it
   * simply gets no heartbeat (the legacy/test path).
   */
  touch?(scopedKey: string): void;
}

/**
 * Narrow an {@link IdempotencyLedger} to the atomic shape. ALL THREE of
 * claim/fill/release must be present — a claim-only ledger (which could leave a
 * dangling NULL claim) fails the guard and takes the SAFE legacy path.
 */
export function isAtomicLedger(
  ledger: IdempotencyLedger | undefined,
): ledger is AtomicIdempotencyLedger {
  return (
    !!ledger &&
    typeof (ledger as AtomicIdempotencyLedger).claim === "function" &&
    typeof (ledger as AtomicIdempotencyLedger).fill === "function" &&
    typeof (ledger as AtomicIdempotencyLedger).release === "function" &&
    typeof (ledger as AtomicIdempotencyLedger).lookupCompleted === "function"
  );
}

export interface ClarifyOption {
  id: string;
  label: string;
}

/** Risky dry-run preview card (SPEC "Risky Writes"). */
export interface PreviewCard {
  actionLabel: string;
  featureGroup: FeatureGroup;
  riskLabels: RiskLabel[];
  targets: EntityRef[];
  expectedChanges: string[];
  reversibility: string;
  warnings: string[];
}

/** The exact payload executed after button confirmation. Never reconstructed from chat. */
export interface ConfirmableOperation {
  operationId: string;
  actionName: string;
  featureGroup: FeatureGroup;
  risks: RiskLabel[];
  payload: Record<string, unknown>;
  mutationPlan?: ExternalMutationPlan;
}

/** A migrated confirmation whose exact host dispatch plan is durable. */
export type PlannedConfirmableOperation = ConfirmableOperation & {
  mutationPlan: ExternalMutationPlan;
};

export type ActionResult = (
  | { kind: "receipt"; receipt: SuccessReceipt | ErrorReceipt }
  | {
      kind: "partial";
      receipt: SuccessReceipt;
      message: string;
      options?: ClarifyOption[];
      recovery: RecoveryHint;
    }
  | { kind: "clarify"; message: string; options?: ClarifyOption[] }
  | { kind: "preview"; preview: PreviewCard; operation: ConfirmableOperation }
) & { operationId?: string };

/** A confirmed commit can truthfully stop after applying only earlier steps. */
export type CommitResult =
  | SuccessReceipt
  | ErrorReceipt
  | Extract<ActionResult, { kind: "partial" }>;

export function isPartialCommitResult(
  result: CommitResult,
): result is Extract<ActionResult, { kind: "partial" }> {
  return "kind" in result && result.kind === "partial";
}

/** Uniform stored form of an action (args already validated by its schema). */
export interface ActionDefinition {
  name: string;
  description: string;
  featureGroup: FeatureGroup;
  risks: RiskLabel[];
  schema: z.ZodTypeAny;
  /** Deliberate top-level compatibility aliases accepted before preprocessing. */
  argumentAliases?: readonly string[];
  /** Deliberate object/map paths whose keys are dynamic (for example `groups`
   *  or an array item map such as `memberships[]`). Every other object path is
   *  closed before Zod preprocessing can strip unknown keys. */
  argumentOpenPaths?: readonly string[];
  /** Override the feature group used for the policy gate from validated args
   *  (e.g. delete_entity maps entityType → group). */
  resolveFeatureGroup?(args: unknown): FeatureGroup;
  handler(ctx: ActionContext, args: unknown): Promise<ActionResult>;
  /** New safe-write path: normalize nonsecret wire intent without mutation. */
  prepareSafeWrite?(ctx: ActionContext, args: unknown): Promise<PreparedSafeWrite>;
  /** Dispatch exactly the prepared safe-write intent. */
  executeSafeWrite?(ctx: ActionContext, prepared: PreparedSafeWrite): Promise<CommitResult>;
  /** Marks a confirmed action whose external effects use mutation-workflow steps. */
  mutationWorkflow?: "durable";
  /** Executes the stored operation after confirmation (risky actions only). */
  commit?(ctx: ActionContext, operation: ConfirmableOperation): Promise<CommitResult>;
  /** Opt into idempotent commits: return the operation's SEMANTIC identity (e.g.
   *  client + items), excluding volatile defaults, so a repeated confirm of the
   *  same intent returns the prior receipt instead of creating a duplicate. */
  idempotencyKey?(operation: ConfirmableOperation): string | undefined;
}

/** Model-visible catalog entry — no schema/handler, never any secret. */
export interface ActionCatalogEntry {
  name: string;
  description: string;
  featureGroup: FeatureGroup;
  risks: RiskLabel[];
  /** Terse argument signature (from the schema) so the model uses exact arg names. */
  args: string;
}

/**
 * Define an action with per-action arg typing (handler receives `z.infer<S>`),
 * erased to the uniform `ActionDefinition` for storage in the catalog.
 */
export function defineAction<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  featureGroup: FeatureGroup;
  risks: RiskLabel[];
  schema: S;
  argumentAliases?: readonly string[];
  argumentOpenPaths?: readonly string[];
  resolveFeatureGroup?(args: z.infer<S>): FeatureGroup;
  handler(ctx: ActionContext, args: z.infer<S>): Promise<ActionResult>;
  prepareSafeWrite?(ctx: ActionContext, args: z.infer<S>): Promise<PreparedSafeWrite>;
  executeSafeWrite?(ctx: ActionContext, prepared: PreparedSafeWrite): Promise<CommitResult>;
  mutationWorkflow?: "durable";
  commit?(ctx: ActionContext, operation: ConfirmableOperation): Promise<CommitResult>;
  idempotencyKey?(operation: ConfirmableOperation): string | undefined;
}): ActionDefinition {
  return def as unknown as ActionDefinition;
}

/**
 * The success shape a {@link defineRiskyAction} preview callback returns to ask
 * for a dry-run preview. `payload` is the exact operation payload that
 * {@link defineRiskyAction.commit} will later receive.
 */
export interface RiskyPreviewResult {
  actionLabel: string;
  targets: EntityRef[];
  expectedChanges: string[];
  reversibility: string;
  warnings?: string[];
  payload: Record<string, unknown>;
}

export interface PreparedSafeWrite {
  /** Normalized, nonsecret wire intent. */
  operation: unknown;
  mutationPlan: ExternalMutationPlan;
}

/** The alternative a preview callback returns to stop and ask for clarification. */
export interface RiskyClarifyResult {
  clarify: string;
  options?: ClarifyOption[];
}

/**
 * Map a {@link RiskyClarifyResult} to the clarify {@link ActionResult} variant.
 * Workflows return the `{ clarify, options? }` shape; this is the one place that
 * renames `clarify` → `message` so the spelling lives once.
 */
export function clarifyResult(c: RiskyClarifyResult): ActionResult {
  return { kind: "clarify", message: c.clarify, options: c.options };
}

/**
 * Build a risky (preview → button-confirm → commit) action without re-stating
 * the action's identity three times. The preview callback returns the
 * preview-specific fields plus the operation `payload`; everything derived from
 * the action's identity (featureGroup, riskLabels, actionName) is filled in from
 * `group`/`risks`/`name` so it can never drift. Emits exactly the same
 * ActionResult / ConfirmableOperation shape as the hand-rolled scaffold.
 */
export function defineRiskyAction<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  group: FeatureGroup;
  risks: RiskLabel[];
  schema: S;
  argumentAliases?: readonly string[];
  argumentOpenPaths?: readonly string[];
  resolveFeatureGroup?(args: z.infer<S>): FeatureGroup;
  idempotencyKey?(payload: Record<string, unknown>): string | undefined;
  preview(
    ctx: ActionContext,
    args: z.infer<S>,
  ): Promise<RiskyPreviewResult | RiskyClarifyResult>;
  commit(ctx: ActionContext, payload: Record<string, unknown>): Promise<CommitResult>;
}): ActionDefinition {
  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: def.risks,
    schema: def.schema,
    ...(def.argumentAliases ? { argumentAliases: def.argumentAliases } : {}),
    ...(def.argumentOpenPaths ? { argumentOpenPaths: def.argumentOpenPaths } : {}),
    ...(def.resolveFeatureGroup
      ? { resolveFeatureGroup: (args: z.infer<S>) => def.resolveFeatureGroup!(args) }
      : {}),
    ...(def.idempotencyKey
      ? {
          idempotencyKey: (operation: ConfirmableOperation) =>
            def.idempotencyKey!(operation.payload),
        }
      : {}),
    async handler(ctx, args): Promise<ActionResult> {
      // The effective feature group for the preview card AND the stored operation
      // is the per-args resolved group when `resolveFeatureGroup` is supplied
      // (e.g. delete_entity maps entityType → group). This MUST match the group
      // the policy gate used in `executeAction` so the confirm-time re-check
      // (`commitConfirmedOperation`/the route, both keyed on `operation.featureGroup`)
      // gates on the same group — never the static `def.group`.
      const group = def.resolveFeatureGroup ? def.resolveFeatureGroup(args) : def.group;
      const r = await def.preview(ctx, args);
      if ("clarify" in r) {
        return { kind: "clarify", message: r.clarify, options: r.options };
      }
      return {
        kind: "preview",
        preview: {
          actionLabel: r.actionLabel,
          featureGroup: group,
          riskLabels: def.risks,
          targets: r.targets,
          expectedChanges: r.expectedChanges,
          reversibility: r.reversibility,
          warnings: r.warnings ?? [],
        },
        operation: {
          operationId: randomUUID(),
          actionName: def.name,
          featureGroup: group,
          risks: def.risks,
          payload: r.payload,
        },
      };
    },
    commit(ctx, operation) {
      return def.commit(ctx, operation.payload);
    },
  });
}

/**
 * Define a safe write with an explicit prepare/execute split. `prepare` may do
 * reads/resolution but must not mutate; `execute` receives only the durable,
 * normalized nonsecret intent persisted before dispatch.
 */
export function defineSafeWriteAction<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  group: FeatureGroup;
  schema: S;
  argumentAliases?: readonly string[];
  argumentOpenPaths?: readonly string[];
  prepare(ctx: ActionContext, args: z.infer<S>): Promise<PreparedSafeWrite> | PreparedSafeWrite;
  execute(ctx: ActionContext, operation: unknown): Promise<CommitResult>;
}): ActionDefinition {
  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: ["safe_write"],
    schema: def.schema,
    ...(def.argumentAliases ? { argumentAliases: def.argumentAliases } : {}),
    ...(def.argumentOpenPaths ? { argumentOpenPaths: def.argumentOpenPaths } : {}),
    prepareSafeWrite: async (ctx, args) => def.prepare(ctx, args),
    executeSafeWrite: (ctx, prepared) => def.execute(ctx, prepared.operation),
    async handler(ctx, args): Promise<ActionResult> {
      const prepared = await def.prepare(ctx, args);
      const result = await def.execute(ctx, prepared.operation);
      return isPartialCommitResult(result)
        ? result
        : { kind: "receipt", receipt: result };
    },
  });
}

/**
 * Build an immediate read action (risk `["read"]`). The handler returns the
 * receipt directly; the builder wraps it in `{ kind: "receipt" }`.
 */
export function defineReadAction<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  group: FeatureGroup;
  schema: S;
  argumentOpenPaths?: readonly string[];
  handler(ctx: ActionContext, args: z.infer<S>): Promise<SuccessReceipt | ErrorReceipt>;
}): ActionDefinition {
  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: ["read"],
    schema: def.schema,
    ...(def.argumentOpenPaths ? { argumentOpenPaths: def.argumentOpenPaths } : {}),
    async handler(ctx, args): Promise<ActionResult> {
      return { kind: "receipt", receipt: await def.handler(ctx, args) };
    },
  });
}
