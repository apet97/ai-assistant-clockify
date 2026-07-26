/**
 * T17-F: the guarded sacrificial v2 live-acceptance harness.
 *
 * BUILT, NOT EXECUTED by T17. It refuses to do anything unless ALL FOUR
 * preconditions hold, and it drives the real v2 flow only:
 *
 *   assistant turn -> OperationPreparationService (zero mutations)
 *     -> the STORED confirmation nonce through ConfirmationService (the
 *        button-equivalent path) -> receipt
 *
 * It never uses `executeTrustedDirectSafeWrite` — the trusted immediate-write
 * bypass exists for direct UI origins and must never stand in for a confirmed
 * assistant write in acceptance evidence.
 *
 * Every resource it creates is prefixed and recorded in an explicit registry,
 * and cleanup runs in reverse dependency order so a child is always removed
 * before its parent. Reports are secret-free and always carry leftover counts.
 */

/** Every live resource this harness may create carries this prefix. */
export const LIVE_V2_PREFIX = "AIASSIST_V2_";

/** The four preconditions. All must hold; a missing one is a refusal, not a warning. */
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

export class LiveCleanupRegistry {
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

export interface LiveV2Report {
  schemaVersion: 1;
  kind: "v2_live_acceptance";
  status: "passed" | "failed" | "refused";
  /** Hashed/short workspace reference only — never the raw credential. */
  workspaceIdSuffix?: string;
  preconditionFailures: LivePreconditionFailure[];
  /** Assistant writes that reached a preview. */
  preparedWrites: number;
  /** Previews confirmed through the stored nonce (the button-equivalent path). */
  confirmedWrites: number;
  /** Mutations observed during preparation. MUST be zero. */
  preparationMutations: number;
  /** Trusted-direct-safe-write calls. MUST be zero — the bypass is never acceptance evidence. */
  trustedBypassCalls: number;
  resourcesCreated: number;
  resourcesRemoved: number;
  /** Anything created and not removed. A passing report requires zero. */
  leftovers: number;
  leftoverKinds: string[];
}

/** Only a zero-leftover, zero-bypass, zero-preparation-mutation run passes. */
export function buildLiveV2Report(input: {
  workspaceId?: string;
  preconditionFailures?: LivePreconditionFailure[];
  preparedWrites?: number;
  confirmedWrites?: number;
  preparationMutations?: number;
  trustedBypassCalls?: number;
  registry?: LiveCleanupRegistry;
  removedIds?: readonly string[];
}): LiveV2Report {
  const failures = input.preconditionFailures ?? [];
  const registry = input.registry ?? new LiveCleanupRegistry();
  const removed = new Set(input.removedIds ?? []);
  const leftovers = registry.all().filter((resource) => !removed.has(resource.id));
  const preparationMutations = input.preparationMutations ?? 0;
  const trustedBypassCalls = input.trustedBypassCalls ?? 0;
  const preparedWrites = input.preparedWrites ?? 0;
  const confirmedWrites = input.confirmedWrites ?? 0;

  const status: LiveV2Report["status"] = failures.length > 0
    ? "refused"
    : (leftovers.length === 0
        && preparationMutations === 0
        && trustedBypassCalls === 0
        && preparedWrites > 0
        && confirmedWrites > 0)
      ? "passed"
      : "failed";

  return {
    schemaVersion: 1,
    kind: "v2_live_acceptance",
    status,
    // Never the raw workspace id and never the key: a bounded suffix is enough
    // to correlate a run without publishing an identifier.
    ...(input.workspaceId ? { workspaceIdSuffix: input.workspaceId.slice(-4) } : {}),
    preconditionFailures: failures,
    preparedWrites,
    confirmedWrites,
    preparationMutations,
    trustedBypassCalls,
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

function main(): void {
  const preconditions = checkLivePreconditions({
    liveOptIn: process.env.LIVE_CLOCKIFY,
    sacrificialMarker: process.env.LIVE_SACRIFICIAL_WORKSPACE_MARKER,
    apiKey: process.env.LIVE_CLOCKIFY_API_KEY,
    workspaceId: process.env.LIVE_WORKSPACE_ID,
    cleanupRegistryPath: process.env.LIVE_V2_CLEANUP_REGISTRY_PATH,
  });
  if (!preconditions.ok) {
    // Refusal is the correct outcome without full authorization. No Clockify
    // call is made, and the report says exactly what was missing.
    process.stdout.write(`${JSON.stringify(
      buildLiveV2Report({ preconditionFailures: preconditions.failures }),
      null,
      2,
    )}\n`);
    process.exitCode = 2;
    return;
  }
  // The live driver itself requires separate per-step operator authorization
  // (T18-H). T17 builds and unit-proves the guard, registry, ordering and report
  // contract; it deliberately performs no live write.
  process.stdout.write(`${JSON.stringify(
    buildLiveV2Report({
      workspaceId: preconditions.workspaceId,
      preconditionFailures: ["cleanup_registry_missing"].filter(() => false) as LivePreconditionFailure[],
    }),
    null,
    2,
  )}\n`);
  process.stderr.write(
    "live_v2_full_not_executed: preconditions satisfied, but executing sacrificial live writes "
    + "requires the separate T18-H authorization step.\n",
  );
  process.exitCode = 2;
}

if (process.argv[1]?.endsWith("live-v2-full.ts")) {
  main();
}
