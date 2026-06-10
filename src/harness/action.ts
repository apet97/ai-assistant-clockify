import type { z } from "zod";
import type { AdminPolicy, FeatureGroup } from "./permissions.js";
import type { RiskLabel } from "./risk.js";
import type { EntityRef, ErrorReceipt, SuccessReceipt } from "./receipts.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { ActionOutcome } from "../metrics/metrics.js";

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
  actionName: string;
  featureGroup: FeatureGroup;
  risks: RiskLabel[];
  payload: Record<string, unknown>;
}

export type ActionResult =
  | { kind: "receipt"; receipt: SuccessReceipt | ErrorReceipt }
  | { kind: "clarify"; message: string; options?: ClarifyOption[] }
  | { kind: "preview"; preview: PreviewCard; operation: ConfirmableOperation };

/** Uniform stored form of an action (args already validated by its schema). */
export interface ActionDefinition {
  name: string;
  description: string;
  featureGroup: FeatureGroup;
  risks: RiskLabel[];
  schema: z.ZodTypeAny;
  /** Override the feature group used for the policy gate from validated args
   *  (e.g. delete_entity maps entityType → group). */
  resolveFeatureGroup?(args: unknown): FeatureGroup;
  handler(ctx: ActionContext, args: unknown): Promise<ActionResult>;
  /** Executes the stored operation after confirmation (risky actions only). */
  commit?(ctx: ActionContext, operation: ConfirmableOperation): Promise<SuccessReceipt | ErrorReceipt>;
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
  resolveFeatureGroup?(args: z.infer<S>): FeatureGroup;
  handler(ctx: ActionContext, args: z.infer<S>): Promise<ActionResult>;
  commit?(ctx: ActionContext, operation: ConfirmableOperation): Promise<SuccessReceipt | ErrorReceipt>;
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

/** The alternative a preview callback returns to stop and ask for clarification. */
export interface RiskyClarifyResult {
  clarify: string;
  options?: ClarifyOption[];
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
  resolveFeatureGroup?(args: z.infer<S>): FeatureGroup;
  idempotencyKey?(payload: Record<string, unknown>): string | undefined;
  preview(
    ctx: ActionContext,
    args: z.infer<S>,
  ): Promise<RiskyPreviewResult | RiskyClarifyResult>;
  commit(ctx: ActionContext, payload: Record<string, unknown>): Promise<SuccessReceipt | ErrorReceipt>;
}): ActionDefinition {
  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: def.risks,
    schema: def.schema,
    ...(def.resolveFeatureGroup ? { resolveFeatureGroup: def.resolveFeatureGroup } : {}),
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
 * Build an immediate read action (risk `["read"]`). The handler returns the
 * receipt directly; the builder wraps it in `{ kind: "receipt" }`.
 */
export function defineReadAction<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  group: FeatureGroup;
  schema: S;
  handler(ctx: ActionContext, args: z.infer<S>): Promise<SuccessReceipt | ErrorReceipt>;
}): ActionDefinition {
  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: ["read"],
    schema: def.schema,
    async handler(ctx, args): Promise<ActionResult> {
      return { kind: "receipt", receipt: await def.handler(ctx, args) };
    },
  });
}
