import type { ActionResult } from "./action.js";
import type { EntityRef, Warning } from "./receipts.js";

/**
 * Atomic multi-step composition (Phase 3 — the intent layer). A composed
 * operation is an ordered list of steps; `runComposition` executes them and owns
 * the transactional semantics so individual handlers (and future curated intent
 * actions) don't each re-implement them:
 *
 * - A **required** step that throws rolls back every entity created so far (its
 *   `undo`s run in REVERSE order) and reports a clean failure — no orphans.
 * - A **best-effort** step (`required: false`) that throws becomes a warning and
 *   the run continues (e.g. starting a timer after creating the project).
 * - A step may **stop** the run by returning a clarify/preview `ActionResult`.
 *   Prior creates are rolled back by default; retaining them requires the caller
 *   to opt in explicitly and surface the outcome as partial.
 *
 * Only entities a step actually CREATED get an `undo`; reused entities are never
 * rolled back. This module is pure orchestration — all Clockify I/O lives in the
 * step closures.
 */

export type StepResult =
  | {
      kind: "done";
      created?: EntityRef[];
      reused?: EntityRef[];
      warnings?: Warning[];
      /** Compensating action to undo this step's creates if a later required step fails. */
      undo?: () => Promise<void>;
    }
  | { kind: "stop"; result: ActionResult };

export interface CompositionStep {
  label: string;
  /** Required: a throw rolls back + fails. Best-effort (false): a throw warns + continues. */
  required: boolean;
  run(): Promise<StepResult>;
}

export type CompositionStatus =
  | { kind: "ok" }
  | {
      kind: "stopped";
      result: ActionResult;
      retained: boolean;
      rolledBack: EntityRef[];
      rollbackWarnings: Warning[];
    }
  | {
      kind: "failed";
      label: string;
      message: string;
      rolledBack: EntityRef[];
      rollbackWarnings: Warning[];
    };

export interface CompositionOutcome {
  created: EntityRef[];
  reused: EntityRef[];
  warnings: Warning[];
  status: CompositionStatus;
}

export interface CompositionOptions {
  /** Keep completed creates when a later step stops. Callers must report partial. */
  stopPolicy?: "rollback" | "retain";
}

/**
 * The truthful cleanup note for a FAILED composition. Reassuring ("Nothing partial
 * was left behind.") ONLY when rollback was clean; when rollback itself failed
 * (rollbackWarnings non-empty) it must say so — otherwise the receipt tells the admin
 * the workspace is clean while orphaned entities remain (enterprise-audit silent
 * failure). Callers must pass `outcome.status.rollbackWarnings`, never assume clean.
 */
export function leftBehindNote(rollbackWarnings: readonly { message: string }[]): string {
  if (rollbackWarnings.length === 0) return "Nothing partial was left behind.";
  return `WARNING: some already-created items could NOT be rolled back and may remain — ${rollbackWarnings
    .map((w) => w.message)
    .join("; ")}. Please check the workspace before retrying.`;
}

interface Undoable {
  refs: EntityRef[];
  undo: () => Promise<void>;
}

async function rollback(undos: Undoable[]): Promise<{ rolledBack: EntityRef[]; rollbackWarnings: Warning[] }> {
  const rolledBack: EntityRef[] = [];
  const rollbackWarnings: Warning[] = [];
  for (let i = undos.length - 1; i >= 0; i -= 1) {
    try {
      await undos[i].undo();
      rolledBack.push(...undos[i].refs);
    } catch (err) {
      const what = undos[i].refs.map((r) => `${r.type} ${r.name ?? r.id}`).join(", ");
      rollbackWarnings.push({
        code: "rollback_failed",
        message: `Could not roll back ${what}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { rolledBack, rollbackWarnings };
}

export async function runComposition(
  steps: CompositionStep[],
  options: CompositionOptions = {},
): Promise<CompositionOutcome> {
  const created: EntityRef[] = [];
  const reused: EntityRef[] = [];
  const warnings: Warning[] = [];
  const undos: Undoable[] = [];

  for (const step of steps) {
    let result: StepResult;
    try {
      result = await step.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!step.required) {
        warnings.push({ code: "step_failed", message: `${step.label}: ${message}` });
        continue;
      }
      const { rolledBack, rollbackWarnings } = await rollback(undos);
      return { created, reused, warnings, status: { kind: "failed", label: step.label, message, rolledBack, rollbackWarnings } };
    }

    if (result.kind === "stop") {
      if (options.stopPolicy === "retain") {
        return {
          created,
          reused,
          warnings,
          status: {
            kind: "stopped",
            result: result.result,
            retained: true,
            rolledBack: [],
            rollbackWarnings: [],
          },
        };
      }
      const { rolledBack, rollbackWarnings } = await rollback(undos);
      return {
        created,
        reused,
        warnings,
        status: {
          kind: "stopped",
          result: result.result,
          retained: false,
          rolledBack,
          rollbackWarnings,
        },
      };
    }
    if (result.created?.length) created.push(...result.created);
    if (result.reused?.length) reused.push(...result.reused);
    if (result.warnings?.length) warnings.push(...result.warnings);
    if (result.undo && result.created?.length) undos.push({ refs: result.created, undo: result.undo });
  }

  return { created, reused, warnings, status: { kind: "ok" } };
}
