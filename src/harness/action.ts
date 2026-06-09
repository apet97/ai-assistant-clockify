import type { z } from "zod";
import type { AdminPolicy, FeatureGroup } from "./permissions.js";
import type { RiskLabel } from "./risk.js";
import type { EntityRef, ErrorReceipt, SuccessReceipt } from "./receipts.js";
import type { IdempotencyLedger } from "./idempotency.js";
import type { WorkspaceClient } from "../clockify/client.js";

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
