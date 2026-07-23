import type { z } from "zod";
import type { AdminPolicy, FeatureGroup } from "./permissions.js";
import type { RiskLabel } from "./risk.js";
import { errorReceipt, type EntityRef, type ErrorReceipt, type RecoveryHint, type SuccessReceipt } from "./receipts.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { ActionOutcome } from "../metrics/metrics.js";
import { randomUUID } from "node:crypto";
import { bindMutationPlanHostCalls } from "./safety-limits.js";
import {
  apiActionMetadataFields,
  type ApiActionMetadataCarrier,
} from "./api-operation.js";
import type {
  ExternalMutationPlan,
  ExternalMutationPlanDraft,
  MutationStepJournal,
} from "./mutation-contract.js";

export type { ExternalMutationPlan, ExternalMutationPlanDraft } from "./mutation-contract.js";
export type {
  ActionOrigin,
  AuthorityModel,
  DiscriminatorTuple,
  ExecutorKind,
  RegistryId,
} from "./action-discriminators.js";

/**
 * A durable operation row can exist before the rest of preparation finishes.
 * Carry its identity across a preparation failure so the result owner can
 * atomically attach the canonical denial instead of leaving a prepared orphan.
 */
export class OperationPreparationError extends Error {
  constructor(
    readonly operationId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "operation_preparation_failed");
    this.name = "OperationPreparationError";
  }
}

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
  /** Caller/lifecycle cancellation for reads and not-yet-dispatched writes. */
  signal?: AbortSignal;
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
  /** Phase 6 raw-argument authority gate. It runs before Zod preprocessing or
   * server-side resolution so provider aliases/coercions cannot widen intent. */
  authorizeWriteArguments?(input: {
    actionName: string;
    rawArgs: unknown;
    authority: WriteAuthorityMetadata;
  }): ErrorReceipt | undefined | Promise<ErrorReceipt | undefined>;
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

/** A verified, bounded projection captured at preview time. Array order is the
 * authoritative target/parent verification order used immediately pre-dispatch. */
export interface TargetSnapshot {
  relation: "target" | "parent";
  ref: EntityRef;
  projection: unknown;
  fingerprint: string;
}

export type ReconciliationStrategyId = "create" | "update" | "delete" | "state-command" | "composed";

/** Machine-checked declaration for a migrated external write. */
export interface DurableMutationContract {
  operationData: {
    source: "prepared_safe_write" | "confirmable_operation";
    normalized: true;
    nonsecret: true;
  };
  mutationPlan: {
    source: "prepared_safe_write" | "preview";
    exact: true;
  };
  targeting:
    | { mode: "create_no_target" }
    | { mode: "snapshots"; relations: ["target" | "parent", ...Array<"target" | "parent">] }
    | { mode: "deferred"; exception: "phase-5-domain-target-verification" };
  reconciliation: {
    strategies: [ReconciliationStrategyId, ...ReconciliationStrategyId[]];
    /** Explicit steps whose ambiguous outcome is intentionally never reconciled
     * (for example a composite create's base POST). */
    unreconciledStepIds?: readonly string[];
    stepBound: true;
    requiresCompleteEvidence: true;
  };
}

/** Catalog-fingerprinted, action-specific grounding rules for the isolated
 * admin-intent declaration pass. Regex values are reviewed source strings and
 * are compiled only by trusted server code with Unicode/case-insensitive flags. */
export interface AuthoredIntentMetadata {
  /** Positive action phrases. The declaration validator additionally requires
   * one of its closed command forms (imperative, direct modal, or explicit
   * first-person request), so a matching phrase in a read question is inert. */
  commandPatterns: readonly string[];
  /** Gerund forms are separate so they are accepted only by the closed
   * "would you mind ..." command form, never as a declarative sentence. */
  commandGerundPatterns: readonly string[];
  /** Phrases that make this otherwise-matching action the wrong surface (for
   * example a project created "from a template" is not a bare project create). */
  forbiddenPatterns: readonly string[];
  /** Optional model-visible literals that become mandatory authority whenever
   * an authored cue occurs in the grounded command/clarification context. */
  literalObligations: readonly {
    anyOfPaths: readonly string[];
    cuePatterns: readonly string[];
    /** Optional named-capture patterns. Each declares a `value` group; any
     * constraint on these paths must cite bytes inside that role-specific group. */
    sourceRolePatterns?: readonly string[];
  }[];
  /** Explicitly reviewed optional leaves whose omission cannot discard a
   * material authored value. Every optional leaf must have exactly one catalog
   * decision: obligation, semantic-alias cue, or this list. */
  safeOmissionPaths: readonly string[];
}

/** Static authority surface for a Clockify write. Every path class is explicit:
 * raw model literals, server-derived identifiers, and permitted host defaults
 * can never silently substitute for one another. */
export interface WriteAuthorityMetadata {
  literalConstraintLimits: {
    maxConstraints: number;
    maxDepth: number;
    maxNodes: number;
    maxBytes: number;
  };
  literalControlledPaths: readonly string[];
  /** Closed-schema literal leaves whose only accepted scalar type is numeric. */
  numericLiteralPaths: readonly string[];
  /** Reviewed natural-language spellings for one exact raw argument path and
   * canonical scalar value. Callers must select this metadata from the exact
   * action being declared; aliases never apply across actions or paths. */
  semanticLiteralAliases: readonly SemanticLiteralAlias[];
  /** Raw literal paths where an exact authored `me` may be represented by the
   * exact authenticated admin id. Catalog hashing binds these reviewed seams. */
  authenticatedSelfLiteralPaths: readonly string[];
  /** Present on every and only safe-write action. Because this object is part of
   * writeAuthority, action/catalog hashes bind the exact authored-intent rules. */
  authoredIntent?: AuthoredIntentMetadata;
  serverDerivedIdPaths: readonly string[];
  permittedServerDefaultPaths: readonly string[];
  /** Exact fields copied unchanged from an authoritative pre-dispatch read. */
  preservedStatePaths: readonly string[];
  cardinality: {
    mode: "single" | "fixed" | "argument";
    /** Maximum exact external plan steps. */
    maxExecutions: number;
    /** Maximum raw items at argumentPath when plan-step and input counts differ. */
    maxArgumentItems?: number;
    argumentPath?: string;
  };
  /** Reviewed host-dispatch grammars. A persisted plan must match one variant
   * exactly: mode, ordered step identifiers, and primary/compensation kinds. */
  mutationPlans: readonly {
    mode: "single" | "curated" | "batch";
    minSteps: number;
    maxSteps: number;
    steps: readonly {
      /** Exact id, or a trailing `*` for an indexed step family. */
      id: string;
      kind: "primary" | "compensation";
      min: number;
      max: number;
    }[];
  }[];
}

/** A deliberately narrow authored phrase -> scalar mapping. Structured JSON
 * remains grounded by exact JSON text; semantic aliases cannot synthesize or
 * widen object/array authority. */
export interface SemanticLiteralAlias {
  path: string;
  value: boolean | string;
  authoredPhrases: readonly string[];
}

/** Validate that an exact persisted plan is fully covered by the action's
 * declared reconciliation contract. Durable writes fail before persistence or
 * dispatch when a step is missing a strategy or invents an undeclared one. */
export function mutationPlanContractError(
  contract: DurableMutationContract | undefined,
  plan: ExternalMutationPlanDraft | undefined,
): string | undefined {
  if (!contract) return "missing_mutation_contract";
  if (!plan || !["single", "curated", "batch"].includes(plan.mode) ||
    !Array.isArray(plan.steps) || plan.steps.length === 0) return "missing_mutation_plan";
  if (plan.mode === "single" && plan.steps.length !== 1) return "invalid_single_mutation_plan";
  const allowed = new Set<string>(contract.reconciliation.strategies);
  const intentionallyUnreconciled = new Set(contract.reconciliation.unreconciledStepIds ?? []);
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step || typeof step.id !== "string" || step.id.length === 0 || ids.has(step.id) ||
      (step.targetFingerprint !== undefined && typeof step.targetFingerprint !== "string") ||
      (step.kind !== "primary" && step.kind !== "compensation")) return "invalid_mutation_plan_step";
    ids.add(step.id);
    if (!step.reconciliationStrategy) {
      if (intentionallyUnreconciled.has(step.id)) continue;
      return `missing_reconciliation_strategy:${step.id}`;
    }
    if (!allowed.has(step.reconciliationStrategy)) return `undeclared_reconciliation_strategy:${step.id}`;
  }
  return undefined;
}

/** The exact payload executed after button confirmation. Never reconstructed from chat. */
export interface ConfirmableOperation {
  operationId: string;
  actionName: string;
  /** Installation/token authority captured when this preview was persisted. */
  installationGeneration?: number;
  featureGroup: FeatureGroup;
  risks: RiskLabel[];
  payload: Record<string, unknown>;
  mutationPlan?: ExternalMutationPlan;
  targetSnapshots?: TargetSnapshot[];
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

/** Fields shared by every stored action definition. Execution-only fields live
 * on the discriminated variants below so a read can never masquerade as a
 * committable write and a safe write cannot carry a second shadow handler. */
interface ActionDefinitionBase extends ApiActionMetadataCarrier {
  name: string;
  description: string;
  featureGroup: FeatureGroup;
  risks: RiskLabel[];
  schema: z.ZodTypeAny;
  /** Deliberate top-level compatibility aliases accepted before preprocessing. */
  argumentAliases?: readonly string[];
  /** Action/path/value-scoped authored phrases accepted by the isolated intent
   * declaration pass. `writeAuthorityFor` validates and freezes these against
   * the model-visible schema before they enter the catalog. */
  semanticLiteralAliases?: readonly SemanticLiteralAlias[];
  /** Deliberate object/map paths whose keys are dynamic (for example `groups`
   *  or an array item map such as `memberships[]`). Every other object path is
   *  closed before Zod preprocessing can strip unknown keys. */
  argumentOpenPaths?: readonly string[];
  /** Override the feature group used for the policy gate from validated args
   *  (e.g. delete_entity maps entityType → group). */
  resolveFeatureGroup?(args: unknown): FeatureGroup;
  /** Marks a confirmed action whose external effects use mutation-workflow steps. */
  mutationWorkflow?: "durable";
  mutationContract?: DurableMutationContract;
  /** Required by the catalog invariant for every Clockify external write. */
  writeAuthority?: WriteAuthorityMetadata;
}

export interface ReadActionDefinition extends ActionDefinitionBase {
  kind: "read";
  handler(ctx: ActionContext, args: unknown): Promise<ActionResult>;
  prepareSafeWrite?: never;
  executeSafeWrite?: never;
  commit?: never;
  idempotencyKey?: never;
}

export interface SafeWriteActionDefinition extends ActionDefinitionBase {
  kind: "safe_write";
  prepareSafeWrite(ctx: ActionContext, args: unknown): Promise<SafeWritePreparationResult>;
  executeSafeWrite(ctx: ActionContext, prepared: BoundedPreparedSafeWrite): Promise<CommitResult>;
  handler?: never;
  commit?: never;
  idempotencyKey?: never;
}

export interface RiskyWriteActionDefinition extends ActionDefinitionBase {
  kind: "risky_write";
  handler(ctx: ActionContext, args: unknown): Promise<ActionResult>;
  prepareSafeWrite?: never;
  executeSafeWrite?: never;
  /** Executes the stored operation after confirmation. */
  commit(ctx: ActionContext, operation: ConfirmableOperation): Promise<CommitResult>;
  /** Opt into idempotent commits: return the operation's SEMANTIC identity (e.g.
   *  client + items), excluding volatile defaults, so a repeated confirm of the
   *  same intent returns the prior receipt instead of creating a duplicate. */
  idempotencyKey?(operation: ConfirmableOperation): string | undefined;
}

/** Uniform catalog form, narrowed by `kind` at every execution boundary. */
export type ActionDefinition =
  | ReadActionDefinition
  | SafeWriteActionDefinition
  | RiskyWriteActionDefinition;

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
interface DefineActionCommon<S extends z.ZodTypeAny> extends ApiActionMetadataCarrier {
  name: string;
  description: string;
  featureGroup: FeatureGroup;
  risks: RiskLabel[];
  schema: S;
  argumentAliases?: readonly string[];
  semanticLiteralAliases?: readonly SemanticLiteralAlias[];
  argumentOpenPaths?: readonly string[];
  resolveFeatureGroup?(args: z.infer<S>): FeatureGroup;
  mutationWorkflow?: "durable";
  mutationContract?: DurableMutationContract;
  writeAuthority?: WriteAuthorityMetadata;
}

type DefineReadActionInput<S extends z.ZodTypeAny> = DefineActionCommon<S> & {
  handler(ctx: ActionContext, args: z.infer<S>): Promise<ActionResult>;
  prepareSafeWrite?: never;
  executeSafeWrite?: never;
  commit?: never;
  idempotencyKey?: never;
};

type DefineSafeWriteActionInput<S extends z.ZodTypeAny> = DefineActionCommon<S> & {
  handler?: never;
  prepareSafeWrite(ctx: ActionContext, args: z.infer<S>): Promise<SafeWritePreparationResult>;
  executeSafeWrite(ctx: ActionContext, prepared: BoundedPreparedSafeWrite): Promise<CommitResult>;
  commit?: never;
  idempotencyKey?: never;
};

type DefineRiskyWriteActionInput<S extends z.ZodTypeAny> = DefineActionCommon<S> & {
  handler(ctx: ActionContext, args: z.infer<S>): Promise<ActionResult>;
  prepareSafeWrite?: never;
  executeSafeWrite?: never;
  commit(ctx: ActionContext, operation: ConfirmableOperation): Promise<CommitResult>;
  idempotencyKey?(operation: ConfirmableOperation): string | undefined;
};

type DefineActionInput<S extends z.ZodTypeAny> =
  | DefineReadActionInput<S>
  | DefineSafeWriteActionInput<S>
  | DefineRiskyWriteActionInput<S>;

export function defineAction<S extends z.ZodTypeAny>(def: DefineActionInput<S>): ActionDefinition {
  const actionName = def.name;
  const hasPrepare = typeof def.prepareSafeWrite === "function";
  const hasExecute = typeof def.executeSafeWrite === "function";
  const hasHandler = typeof def.handler === "function";
  const hasCommit = typeof def.commit === "function";

  if (hasPrepare || hasExecute) {
    if (!hasPrepare || !hasExecute || hasHandler || hasCommit) {
      throw new Error(`invalid_safe_write_definition:${actionName}`);
    }
    return { ...def, kind: "safe_write" } as unknown as SafeWriteActionDefinition;
  }
  if (def.risks.length > 0 && def.risks.every((risk) => risk === "read")) {
    if (!hasHandler || hasCommit) throw new Error(`invalid_read_definition:${actionName}`);
    return { ...def, kind: "read" } as unknown as ReadActionDefinition;
  }
  if (hasHandler && hasCommit) {
    return { ...def, kind: "risky_write" } as unknown as RiskyWriteActionDefinition;
  }
  throw new Error(`unclassified_action_definition:${actionName}`);
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
  /** Exact durable host-step order persisted with the confirmation. */
  mutationPlan?: ExternalMutationPlanDraft;
  /** Ordered target/parent evidence captured from authoritative reads. */
  targetSnapshots?: TargetSnapshot[];
}

export interface PreparedSafeWrite {
  /** Normalized, nonsecret wire intent. */
  operation: unknown;
  mutationPlan: ExternalMutationPlanDraft;
}

/** A prepared safe write after the deterministic estimator has bound its
 * complete host-call reservation. Only this shape may reach persistence or
 * dispatch. */
export interface BoundedPreparedSafeWrite {
  operation: unknown;
  mutationPlan: ExternalMutationPlan;
}

/** A grounded prepare-time stop for an immediate write. The explicit `kind`
 * discriminator prevents normalized operation data from being mistaken for a
 * clarification merely because it happens to contain a `clarify` property. */
export interface SafeWriteClarification {
  kind: "clarify";
  clarify: string;
  options?: ClarifyOption[];
}

/** Preparation proved that the requested end state already exists and no host
 * mutation is needed. This deliberately bypasses mutation-plan persistence;
 * representing a read-only verification as a completed mutation step would
 * violate the exact-one-physical-dispatch invariant. */
export interface SafeWriteNoop {
  kind: "noop";
  receipt: SuccessReceipt | ErrorReceipt;
}

/** Read-only preparation either produces durable wire intent or asks the admin
 * to choose among grounded options. Plain `PreparedSafeWrite` remains accepted
 * so existing builders do not need a mechanical discriminator migration. */
export type SafeWritePreparationResult = PreparedSafeWrite | SafeWriteClarification | SafeWriteNoop;

export function isSafeWriteClarification(value: unknown): value is SafeWriteClarification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "clarify" || typeof candidate.clarify !== "string" || candidate.clarify.trim() === "") {
    return false;
  }
  if (candidate.options === undefined) return true;
  return Array.isArray(candidate.options) && candidate.options.every((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return false;
    const item = option as Record<string, unknown>;
    return typeof item.id === "string" && item.id.length > 0 &&
      typeof item.label === "string" && item.label.length > 0;
  });
}

export function isSafeWriteNoop(value: unknown): value is SafeWriteNoop {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "noop" || !candidate.receipt || typeof candidate.receipt !== "object" ||
      Array.isArray(candidate.receipt)) return false;
  return typeof (candidate.receipt as Record<string, unknown>).ok === "boolean";
}

/** Runtime boundary for provider/workflow code. A malformed pseudo-prepared
 * value never reaches authorization, persistence, or dispatch. Exact plan
 * compatibility remains the action contract validator's responsibility. */
export function isPreparedSafeWrite(value: unknown): value is PreparedSafeWrite {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.hasOwn(candidate, "kind") || !Object.hasOwn(candidate, "operation")) return false;
  const plan = candidate.mutationPlan;
  return !!plan && typeof plan === "object" && !Array.isArray(plan) &&
    ["single", "curated", "batch"].includes((plan as { mode?: unknown }).mode as string) &&
    Array.isArray((plan as { steps?: unknown }).steps) &&
    (plan as { steps: unknown[] }).steps.length > 0;
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
export function defineRiskyAction<S extends z.ZodTypeAny>(def: ApiActionMetadataCarrier & {
  name: string;
  description: string;
  group: FeatureGroup;
  risks: RiskLabel[];
  schema: S;
  argumentAliases?: readonly string[];
  semanticLiteralAliases?: readonly SemanticLiteralAlias[];
  argumentOpenPaths?: readonly string[];
  mutationWorkflow?: "durable";
  mutationContract?: DurableMutationContract;
  resolveFeatureGroup?(args: z.infer<S>): FeatureGroup;
  idempotencyKey?(
    payload: Record<string, unknown>,
    operation: ConfirmableOperation,
  ): string | undefined;
  preview(
    ctx: ActionContext,
    args: z.infer<S>,
    operationId: string,
  ): Promise<RiskyPreviewResult | RiskyClarifyResult>;
  commit(
    ctx: ActionContext,
    payload: Record<string, unknown>,
    operation: ConfirmableOperation,
  ): Promise<CommitResult>;
}): RiskyWriteActionDefinition {
  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: def.risks,
    schema: def.schema,
    ...apiActionMetadataFields(def),
    ...(def.argumentAliases ? { argumentAliases: def.argumentAliases } : {}),
    ...(def.semanticLiteralAliases ? { semanticLiteralAliases: def.semanticLiteralAliases } : {}),
    ...(def.argumentOpenPaths ? { argumentOpenPaths: def.argumentOpenPaths } : {}),
    ...(def.mutationWorkflow ? { mutationWorkflow: def.mutationWorkflow } : {}),
    ...(def.mutationContract ? { mutationContract: def.mutationContract } : {}),
    ...(def.resolveFeatureGroup
      ? { resolveFeatureGroup: (args: z.infer<S>) => def.resolveFeatureGroup!(args) }
      : {}),
    ...(def.idempotencyKey
      ? {
          idempotencyKey: (operation: ConfirmableOperation) =>
            def.idempotencyKey!(operation.payload, operation),
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
      const operationId = randomUUID();
      const r = await def.preview(ctx, args, operationId);
      if ("clarify" in r) {
        return { kind: "clarify", message: r.clarify, options: r.options };
      }
      const planError = def.mutationWorkflow === "durable"
        ? mutationPlanContractError(def.mutationContract, r.mutationPlan)
        : undefined;
      if (planError) {
        return {
          kind: "receipt",
          receipt: errorReceipt({
            action: def.name,
            code: "invalid_mutation_plan",
            message: "The prepared host mutation plan is incompatible with this action's durable contract.",
            recovery: { hint: "Create a fresh preview after the action contract is corrected.", retryable: false },
          }),
        };
      }
      const mutationPlan = r.mutationPlan
        ? bindMutationPlanHostCalls(def.name, r.payload, r.mutationPlan)
        : undefined;
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
          operationId,
          actionName: def.name,
          featureGroup: group,
          risks: def.risks,
          payload: r.payload,
          ...(mutationPlan ? { mutationPlan } : {}),
          targetSnapshots: r.targetSnapshots ?? [],
        },
      };
    },
    commit(ctx, operation) {
      return def.commit(ctx, operation.payload, operation);
    },
  }) as RiskyWriteActionDefinition;
}

/**
 * Define a safe write with an explicit prepare/execute split. `prepare` may do
 * reads/resolution but must not mutate; `execute` receives only the durable,
 * normalized nonsecret intent persisted before dispatch.
 */
export function defineSafeWriteAction<S extends z.ZodTypeAny>(def: ApiActionMetadataCarrier & {
  name: string;
  description: string;
  group: FeatureGroup;
  schema: S;
  argumentAliases?: readonly string[];
  semanticLiteralAliases?: readonly SemanticLiteralAlias[];
  argumentOpenPaths?: readonly string[];
  prepare(
    ctx: ActionContext,
    args: z.infer<S>,
  ): Promise<SafeWritePreparationResult> | SafeWritePreparationResult;
  execute(ctx: ActionContext, operation: unknown): Promise<CommitResult>;
}): SafeWriteActionDefinition {
  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: ["safe_write"],
    schema: def.schema,
    ...apiActionMetadataFields(def),
    ...(def.argumentAliases ? { argumentAliases: def.argumentAliases } : {}),
    ...(def.semanticLiteralAliases ? { semanticLiteralAliases: def.semanticLiteralAliases } : {}),
    ...(def.argumentOpenPaths ? { argumentOpenPaths: def.argumentOpenPaths } : {}),
    prepareSafeWrite: async (ctx, args) => def.prepare(ctx, args),
    executeSafeWrite: (ctx, prepared) => def.execute(ctx, prepared.operation),
  }) as SafeWriteActionDefinition;
}

/**
 * Build an immediate read action (risk `["read"]`). The handler returns the
 * receipt directly; the builder wraps it in `{ kind: "receipt" }`.
 */
export function defineReadAction<S extends z.ZodTypeAny>(def: ApiActionMetadataCarrier & {
  name: string;
  description: string;
  group: FeatureGroup;
  schema: S;
  argumentOpenPaths?: readonly string[];
  handler(ctx: ActionContext, args: z.infer<S>): Promise<SuccessReceipt | ErrorReceipt>;
}): ReadActionDefinition {
  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: ["read"],
    schema: def.schema,
    ...apiActionMetadataFields(def),
    ...(def.argumentOpenPaths ? { argumentOpenPaths: def.argumentOpenPaths } : {}),
    async handler(ctx, args): Promise<ActionResult> {
      return { kind: "receipt", receipt: await def.handler(ctx, args) };
    },
  }) as ReadActionDefinition;
}
