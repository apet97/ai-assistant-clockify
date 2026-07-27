/**
 * Closed origin/registry/authority/executor matrix for v2 confirmation persistence.
 * Never infer a branch from action name, risk, or missing companion fields alone.
 */

export type ActionOrigin = "assistant" | "direct_ui" | "system" | "live_test";

export type RegistryId = "v1-internal" | "v2-api" | "v2-local";

export type AuthorityModel =
  | "legacy_v1"
  | "intent_capability_v1"
  | "preview_confirmation_v2"
  | "trusted_direct_v2"
  | "undo_v2";

export type ExecutorKind =
  | "legacy_v1"
  | "prepared_safe_write"
  | "risky_commit"
  | "direct_safe_write"
  | "undo_commit";

export interface DiscriminatorTuple {
  origin: ActionOrigin;
  registryId: RegistryId;
  authorityModel: AuthorityModel;
  executorKind: ExecutorKind;
  /** Required for v2 assistant preview rows. */
  runId?: string;
  /** Present when this preview belongs to a multi-write confirmation batch. */
  batchId?: string;
  /** Required for undo_v2 operation rows. */
  sourceUndoId?: string;
  sourceUndoHash?: string;
  /** Required for preview_confirmation_v2 operation rows. */
  fieldProvenanceJson?: string;
  fieldProvenanceHash?: string;
}

export type DiscriminatorSurface = "pending_confirmation" | "operation_run";

export type DiscriminatorMatrixResult =
  | { ok: true }
  | { ok: false; code: string };

const TRUSTED_ORIGINS = new Set<ActionOrigin>(["direct_ui", "system", "live_test"]);
const PREVIEW_EXECUTORS = new Set<ExecutorKind>(["prepared_safe_write", "risky_commit"]);
const V1_AUTHORITIES = new Set<AuthorityModel>(["legacy_v1", "intent_capability_v1"]);

function isSha256(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isBoundedProvenanceJson(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value.length > 65_536) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** Pure mirror of the SQLite discriminator triggers for tests and callers. */
export function validateDiscriminatorMatrix(
  surface: DiscriminatorSurface,
  input: Partial<DiscriminatorTuple>,
): DiscriminatorMatrixResult {
  const { origin, registryId, authorityModel, executorKind } = input;
  if (!origin || !registryId || !authorityModel || !executorKind) {
    return { ok: false, code: "discriminator_incomplete" };
  }

  if (surface === "pending_confirmation") {
    if (authorityModel === "trusted_direct_v2" || authorityModel === "undo_v2") {
      return { ok: false, code: "confirmation_authority_invalid" };
    }
    if (
      registryId === "v1-internal" &&
      V1_AUTHORITIES.has(authorityModel) &&
      executorKind === "legacy_v1"
    ) {
      return { ok: true };
    }
    if (
      origin === "assistant" &&
      registryId === "v2-api" &&
      authorityModel === "preview_confirmation_v2" &&
      PREVIEW_EXECUTORS.has(executorKind) &&
      typeof input.runId === "string" &&
      input.runId.length > 0
    ) {
      return { ok: true };
    }
    return { ok: false, code: "discriminator_matrix_invalid" };
  }

  if (
    registryId === "v1-internal" &&
    V1_AUTHORITIES.has(authorityModel) &&
    executorKind === "legacy_v1"
  ) {
    return { ok: true };
  }

  if (
    origin === "assistant" &&
    registryId === "v2-api" &&
    authorityModel === "preview_confirmation_v2" &&
    PREVIEW_EXECUTORS.has(executorKind) &&
    typeof input.runId === "string" &&
    input.runId.length > 0 &&
    isBoundedProvenanceJson(input.fieldProvenanceJson) &&
    isSha256(input.fieldProvenanceHash)
  ) {
    return { ok: true };
  }

  if (
    TRUSTED_ORIGINS.has(origin) &&
    (registryId === "v2-api" || registryId === "v2-local") &&
    authorityModel === "trusted_direct_v2" &&
    executorKind === "direct_safe_write"
  ) {
    return { ok: true };
  }

  if (
    TRUSTED_ORIGINS.has(origin) &&
    registryId === "v2-local" &&
    authorityModel === "undo_v2" &&
    executorKind === "undo_commit" &&
    typeof input.sourceUndoId === "string" &&
    input.sourceUndoId.length > 0 &&
    isSha256(input.sourceUndoHash)
  ) {
    return { ok: true };
  }

  return { ok: false, code: "discriminator_matrix_invalid" };
}

/** Deterministic v1 coexistence tuple from persisted capability linkage only. */
export function v1DiscriminatorFromCapability(capabilityId?: string): DiscriminatorTuple {
  return capabilityId
    ? {
        origin: "assistant",
        registryId: "v1-internal",
        authorityModel: "intent_capability_v1",
        executorKind: "legacy_v1",
      }
    : {
        origin: "assistant",
        registryId: "v1-internal",
        authorityModel: "legacy_v1",
        executorKind: "legacy_v1",
      };
}
