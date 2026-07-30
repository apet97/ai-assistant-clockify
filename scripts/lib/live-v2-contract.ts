import { readFileSync, writeFileSync } from "node:fs";

/**
 * B3: the guard, registry, and report CONTRACT of the sacrificial v2 live
 * driver (`scripts/live-v2-full.ts`). Pure data and local-filesystem logic
 * only — nothing in this module may ever touch Clockify or the network.
 */

/** Every live resource this harness may create carries this prefix. */
export const LIVE_V2_PREFIX = "AIASSIST_V2_";

/**
 * The FIVE preconditions. All must hold; a missing one is a refusal, not a
 * warning. The fifth (the cleanup-registry path) is CONSUMED, not decorative:
 * the driver persists every created entity there as it is created, so an
 * interrupted run stays cleanable in reverse dependency order.
 */
export interface LivePreconditionInput {
  liveOptIn: string | undefined;
  sacrificialMarker: string | undefined;
  apiKey: string | undefined;
  workspaceId: string | undefined;
  cleanupRegistryPath: string | undefined;
}

export type LivePreconditionFailure =
  | "live_opt_in_missing"
  | "sacrificial_marker_missing"
  | "credentials_missing"
  | "workspace_missing"
  | "cleanup_registry_missing";

export type LivePreconditionResult =
  | { ok: true; workspaceId: string; cleanupRegistryPath: string }
  | { ok: false; failures: LivePreconditionFailure[] };

/**
 * The sacrificial marker must be the literal opt-in string. A workspace id alone
 * is NOT proof a workspace is disposable, which is exactly the mistake this
 * guard exists to prevent.
 */
export const SACRIFICIAL_MARKER = "clockify-live-smoke-sacrificial";

export function checkLivePreconditions(input: LivePreconditionInput): LivePreconditionResult {
  const failures: LivePreconditionFailure[] = [];
  if (input.liveOptIn !== "1") failures.push("live_opt_in_missing");
  if (input.sacrificialMarker !== SACRIFICIAL_MARKER) failures.push("sacrificial_marker_missing");
  if (!input.apiKey) failures.push("credentials_missing");
  if (!input.workspaceId) failures.push("workspace_missing");
  if (!input.cleanupRegistryPath) failures.push("cleanup_registry_missing");
  if (failures.length > 0) return { ok: false, failures };
  return {
    ok: true,
    workspaceId: input.workspaceId as string,
    cleanupRegistryPath: input.cleanupRegistryPath as string,
  };
}

/**
 * The separate PER-STEP live-write authorization (the variable that replaces
 * the old prose-only "T18-H" step). The five preconditions prove the TARGET is
 * sacrificial; this variable is the operator's explicit instruction to execute
 * writes in THIS run. Without it the driver reports `not_executed` and makes
 * no Clockify call. Authority never carries between runs: the variable must be
 * set per invocation, and only the exact literal counts.
 */
export const LIVE_V2_WRITE_AUTHORIZATION_VARIABLE = "LIVE_V2_WRITE_AUTHORIZATION";
export const LIVE_V2_WRITE_AUTHORIZATION_VALUE = "execute-sacrificial-v2-writes";

export type LiveV2ExecutionDecision =
  | { kind: "refused"; failures: LivePreconditionFailure[] }
  | {
      kind: "not_executed";
      reason: "live_write_authorization_missing";
      workspaceId: string;
      cleanupRegistryPath: string;
    }
  | { kind: "execute"; workspaceId: string; apiKey: string; cleanupRegistryPath: string };

/** Refusal (missing preconditions) beats not_executed (missing authorization);
 * only the exact documented literal authorizes execution. */
export function decideLiveV2Execution(
  env: Record<string, string | undefined>,
): LiveV2ExecutionDecision {
  const preconditions = checkLivePreconditions({
    liveOptIn: env.LIVE_CLOCKIFY,
    sacrificialMarker: env.LIVE_SACRIFICIAL_WORKSPACE_MARKER,
    apiKey: env.LIVE_CLOCKIFY_API_KEY,
    workspaceId: env.LIVE_WORKSPACE_ID,
    cleanupRegistryPath: env.LIVE_V2_CLEANUP_REGISTRY_PATH,
  });
  if (!preconditions.ok) return { kind: "refused", failures: preconditions.failures };
  if (env[LIVE_V2_WRITE_AUTHORIZATION_VARIABLE] !== LIVE_V2_WRITE_AUTHORIZATION_VALUE) {
    return {
      kind: "not_executed",
      reason: "live_write_authorization_missing",
      workspaceId: preconditions.workspaceId,
      cleanupRegistryPath: preconditions.cleanupRegistryPath,
    };
  }
  return {
    kind: "execute",
    workspaceId: preconditions.workspaceId,
    apiKey: env.LIVE_CLOCKIFY_API_KEY as string,
    cleanupRegistryPath: preconditions.cleanupRegistryPath,
  };
}

/** Resource kinds this harness may create, in DEPENDENCY order (parent first). */
export const LIVE_RESOURCE_ORDER = ["client", "project", "task", "tag"] as const;
export type LiveResourceKind = (typeof LIVE_RESOURCE_ORDER)[number];

export interface LiveResource {
  kind: LiveResourceKind;
  id: string;
  /** Prefixed name; a resource without the prefix can never enter the registry. */
  name: string;
  /** Parent id for a child resource (a task's project). */
  parentId?: string;
}

/** The minimal registry view the report builder needs. */
export interface CleanupRegistryView {
  all(): LiveResource[];
  size(): number;
}

export class LiveCleanupRegistry implements CleanupRegistryView {
  private readonly resources: LiveResource[] = [];

  /** Record a created resource. A non-prefixed name is rejected: the harness may
   * only ever own — and therefore only ever delete — its own fixtures. */
  record(resource: LiveResource): void {
    if (!resource.name.startsWith(LIVE_V2_PREFIX)) {
      throw new Error(`live_resource_not_fixture_owned:${resource.kind}`);
    }
    if (!LIVE_RESOURCE_ORDER.includes(resource.kind)) {
      throw new Error(`live_resource_unknown_kind:${resource.kind}`);
    }
    this.resources.push({ ...resource });
  }

  /** Reverse dependency order: children before parents, insertion order reversed within a kind. */
  cleanupOrder(): LiveResource[] {
    const ranked = [...this.resources].map((resource, index) => ({
      resource,
      depth: LIVE_RESOURCE_ORDER.indexOf(resource.kind),
      index,
    }));
    ranked.sort((left, right) => (right.depth - left.depth) || (right.index - left.index));
    return ranked.map((entry) => entry.resource);
  }

  all(): LiveResource[] {
    return [...this.resources];
  }

  size(): number {
    return this.resources.length;
  }
}

export interface PersistedRegistryFileEntry extends LiveResource {
  removed: boolean;
}

export interface PersistedRegistryFile {
  schemaVersion: 1;
  kind: "v2_live_cleanup_registry";
  updatedAtIso: string;
  resources: PersistedRegistryFileEntry[];
}

/**
 * The consumer of the FIFTH precondition: a cleanup registry persisted to
 * `LIVE_V2_CLEANUP_REGISTRY_PATH`. The file is (re)written on construction —
 * proving the path is writable BEFORE any live resource can exist — and after
 * every `record`/`markRemoved`, so a run interrupted at any point leaves a
 * complete on-disk record of what still needs deleting, already recoverable in
 * reverse dependency order via `pendingCleanupFromFile`.
 */
export class PersistedCleanupRegistry implements CleanupRegistryView {
  private readonly registry = new LiveCleanupRegistry();
  private readonly removed = new Set<string>();

  constructor(
    readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.persist();
  }

  record(resource: LiveResource): void {
    this.registry.record(resource);
    this.persist();
  }

  markRemoved(id: string): void {
    this.removed.add(id);
    this.persist();
  }

  /** Still-live resources in reverse dependency order (children first). */
  pendingCleanup(): LiveResource[] {
    return this.registry.cleanupOrder().filter((resource) => !this.removed.has(resource.id));
  }

  removedIds(): string[] {
    return [...this.removed];
  }

  all(): LiveResource[] {
    return this.registry.all();
  }

  size(): number {
    return this.registry.size();
  }

  private persist(): void {
    const file: PersistedRegistryFile = {
      schemaVersion: 1,
      kind: "v2_live_cleanup_registry",
      updatedAtIso: this.now().toISOString(),
      resources: this.registry.all().map((resource) => ({
        ...resource,
        removed: this.removed.has(resource.id),
      })),
    };
    // 0600: the registry carries live resource ids; it is operator-local state.
    writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

export function readCleanupRegistryFile(filePath: string): PersistedRegistryFile {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PersistedRegistryFile;
  if (parsed.kind !== "v2_live_cleanup_registry" || !Array.isArray(parsed.resources)) {
    throw new Error("live_cleanup_registry_malformed");
  }
  return parsed;
}

/**
 * Recover the reverse-dependency cleanup order from the persisted file alone
 * (the interrupted-run path). Entries are replayed through the in-memory
 * registry, so a tampered file naming a non-fixture resource fails closed
 * instead of directing the harness at real data.
 */
export function pendingCleanupFromFile(file: PersistedRegistryFile): LiveResource[] {
  const registry = new LiveCleanupRegistry();
  const removed = new Set<string>();
  for (const entry of file.resources) {
    const { removed: entryRemoved, ...resource } = entry;
    registry.record(resource);
    if (entryRemoved) removed.add(resource.id);
  }
  return registry.cleanupOrder().filter((resource) => !removed.has(resource.id));
}

/**
 * The bounded per-case verdict carried by the report. Only compile-time
 * literals may appear here — the driver's case id, the catalog action name,
 * the verdict, and a bounded failure code. Never a resource id, a resource
 * name, or a nonce.
 */
export interface LiveV2CaseReport {
  id: string;
  actionName: string;
  status: "passed" | "failed";
  failureCode?: string;
}

export interface LiveV2Report {
  schemaVersion: 2;
  kind: "v2_live_acceptance";
  status: "passed" | "failed" | "refused" | "not_executed";
  /** Which composition ran: the fake host (dry_run) or real Clockify (live). */
  mode: "dry_run" | "live";
  /** Hashed/short workspace reference only — never the raw credential. */
  workspaceIdSuffix?: string;
  preconditionFailures: LivePreconditionFailure[];
  /** Write cases the driver INTENDED to run. A pass requires evidence for each. */
  plannedWrites: number;
  /** Per-case verdicts. A pass requires every planned case present and passed —
   * aggregate counters alone can never produce a pass. */
  cases: LiveV2CaseReport[];
  /** Assistant writes that reached a preview. */
  preparedWrites: number;
  /** Previews confirmed through the stored nonce (the button-equivalent path). */
  confirmedWrites: number;
  /** Mutations observed during preparation. MUST be zero. */
  preparationMutations: number;
  /** Trusted-direct-safe-write calls. MUST be zero — the bypass is never acceptance evidence. */
  trustedBypassCalls: number;
  /** Confirmed writes whose nonce was PROVEN one-use by a rejected replay probe.
   * A passing run requires one rejection per confirmed write. */
  nonceReplayRejections: number;
  /** Confirmed creations the cleanup registry could not track. MUST be zero. */
  untrackedCreations: number;
  resourcesCreated: number;
  resourcesRemoved: number;
  /** Anything created and not removed. A passing report requires zero. */
  leftovers: number;
  leftoverKinds: string[];
}

/**
 * Only a run with complete, all-passed PER-CASE evidence — every planned case
 * present and judged `passed` — whose aggregate counters agree with that
 * evidence (every planned case prepared, every prepared write confirmed,
 * every confirmed nonce proven one-use, zero leftovers / bypass calls /
 * preparation mutations / untracked creations) passes. Aggregate counters
 * alone can never produce a pass, so a lost case, an unconfirmed write, or a
 * case-level failure code always fails the report — the report both modes
 * exit on, not merely test-side evidence.
 */
export function buildLiveV2Report(input: {
  mode?: "dry_run" | "live";
  workspaceId?: string;
  preconditionFailures?: LivePreconditionFailure[];
  /** Preconditions held but the per-step write authorization was absent. */
  notExecuted?: boolean;
  /** How many cases the driver INTENDED to run; defaults to the evidence
   * length, so a caller can only prove a dropped case, never hide one. */
  plannedWrites?: number;
  cases?: readonly LiveV2CaseReport[];
  preparedWrites?: number;
  confirmedWrites?: number;
  preparationMutations?: number;
  trustedBypassCalls?: number;
  nonceReplayRejections?: number;
  untrackedCreations?: number;
  registry?: CleanupRegistryView;
  removedIds?: readonly string[];
}): LiveV2Report {
  const failures = input.preconditionFailures ?? [];
  const registry = input.registry ?? new LiveCleanupRegistry();
  const removed = new Set(input.removedIds ?? []);
  const leftovers = registry.all().filter((resource) => !removed.has(resource.id));
  const cases: LiveV2CaseReport[] = (input.cases ?? []).map((reportCase) => ({
    id: reportCase.id,
    actionName: reportCase.actionName,
    status: reportCase.status,
    ...(reportCase.failureCode !== undefined ? { failureCode: reportCase.failureCode } : {}),
  }));
  const plannedWrites = input.plannedWrites ?? cases.length;
  const preparationMutations = input.preparationMutations ?? 0;
  const trustedBypassCalls = input.trustedBypassCalls ?? 0;
  const preparedWrites = input.preparedWrites ?? 0;
  const confirmedWrites = input.confirmedWrites ?? 0;
  const nonceReplayRejections = input.nonceReplayRejections ?? 0;
  const untrackedCreations = input.untrackedCreations ?? 0;

  const everyCasePassed = cases.length > 0
    && cases.every((reportCase) => reportCase.status === "passed");
  const countersConsistent = cases.length === plannedWrites
    && preparedWrites === cases.length
    && confirmedWrites === preparedWrites
    && nonceReplayRejections === confirmedWrites;

  const status: LiveV2Report["status"] = failures.length > 0
    ? "refused"
    : input.notExecuted
      ? "not_executed"
      : (everyCasePassed
          && countersConsistent
          && leftovers.length === 0
          && preparationMutations === 0
          && trustedBypassCalls === 0
          && untrackedCreations === 0)
        ? "passed"
        : "failed";

  return {
    schemaVersion: 2,
    kind: "v2_live_acceptance",
    status,
    mode: input.mode ?? "live",
    // Never the raw workspace id and never the key: a bounded suffix is enough
    // to correlate a run without publishing an identifier.
    ...(input.workspaceId ? { workspaceIdSuffix: input.workspaceId.slice(-4) } : {}),
    preconditionFailures: failures,
    plannedWrites,
    cases,
    preparedWrites,
    confirmedWrites,
    preparationMutations,
    trustedBypassCalls,
    nonceReplayRejections,
    untrackedCreations,
    resourcesCreated: registry.size(),
    resourcesRemoved: registry.size() - leftovers.length,
    leftovers: leftovers.length,
    leftoverKinds: [...new Set(leftovers.map((resource) => resource.kind))].sort(),
  };
}

/** A report may never contain a credential-shaped value. */
export function reportContainsSecret(report: LiveV2Report, secrets: readonly string[]): boolean {
  const serialized = JSON.stringify(report);
  return secrets.some((secret) => secret.length > 0 && serialized.includes(secret));
}
