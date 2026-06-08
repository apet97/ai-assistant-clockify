import type { ModelPlan, PlannedAction } from "../assistant/planner.js";

/**
 * Pure planner scorer (Phase 1A — the meter). Given a `ModelPlan` the planner
 * produced and an `ExpectSpec` for the case, it decides pass/fail and returns the
 * human-readable reasons for every failed matcher. It is deterministic in its
 * inputs (no catalog, clock, or I/O) so it is unit-testable and safe to call from
 * the opt-in eval script. Risk lookups for the destructive guard are injected via
 * `ScoreContext.riskFor` (the script wires the real catalog) — keeping the scorer
 * pure while still letting it see an action's risk class.
 */

export interface ArgMatcher {
  /** Every listed key must be present on the matched action's arguments. */
  present?: string[];
  /** At least one listed key must be present (e.g. `project` OR `projectName`). */
  presentAny?: string[];
  /** Each key must deep-equal the matched action's argument value. */
  equals?: Record<string, unknown>;
}

export interface ExpectSpec {
  /** Expected plan kind ("answer" | "actions" | "clarify"). */
  kind?: ModelPlan["kind"];
  /** Exactly this action name must appear among the proposed actions. */
  action?: string;
  /** At least one proposed action's name must be in this set. */
  anyAction?: string[];
  /** Arg matchers checked against the matched action (or the first action). */
  args?: ArgMatcher;
  /** No proposed action may carry the `destructive` risk label. */
  noDestructive?: boolean;
  /** Free-text note about the case (not scored). */
  note?: string;
}

export interface ScoreContext {
  /** Resolve an action's risk labels (from the catalog) for the destructive guard. */
  riskFor?: (actionName: string) => readonly string[];
}

export interface ScoreResult {
  pass: boolean;
  reasons: string[];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

function actionNames(actions: PlannedAction[]): string {
  return actions.length ? actions.map((a) => a.name).join(", ") : "none";
}

export function scoreCase(plan: ModelPlan, expect: ExpectSpec, ctx: ScoreContext = {}): ScoreResult {
  const reasons: string[] = [];
  const actions = plan.actions ?? [];

  if (expect.kind && plan.kind !== expect.kind) {
    reasons.push(`kind: expected "${expect.kind}", got "${plan.kind}"`);
  }

  // Resolve which proposed action the arg matchers apply to.
  let target: PlannedAction | undefined;

  if (expect.action) {
    const match = actions.find((a) => a.name === expect.action);
    if (!match) {
      reasons.push(`action: expected "${expect.action}", got [${actionNames(actions)}]`);
    } else {
      target = match;
    }
  }

  if (expect.anyAction && expect.anyAction.length > 0) {
    const set = new Set(expect.anyAction);
    const match = actions.find((a) => set.has(a.name));
    if (!match) {
      reasons.push(`anyAction: expected one of [${expect.anyAction.join(", ")}], got [${actionNames(actions)}]`);
    } else if (!target) {
      target = match;
    }
  }

  if (expect.args) {
    const argTarget = target ?? actions[0];
    if (!argTarget) {
      reasons.push("args: no proposed action to match arguments against");
    } else {
      const args = argTarget.arguments ?? {};
      for (const key of expect.args.present ?? []) {
        if (!(key in args)) reasons.push(`args.present: missing "${key}" on ${argTarget.name}`);
      }
      if (expect.args.presentAny && expect.args.presentAny.length > 0) {
        if (!expect.args.presentAny.some((k) => k in args)) {
          reasons.push(`args.presentAny: none of [${expect.args.presentAny.join(", ")}] on ${argTarget.name}`);
        }
      }
      for (const [key, value] of Object.entries(expect.args.equals ?? {})) {
        if (!deepEqual(args[key], value)) {
          reasons.push(`args.equals: ${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(args[key])}`);
        }
      }
    }
  }

  if (expect.noDestructive) {
    const riskFor = ctx.riskFor ?? (() => []);
    const offenders = actions.filter((a) => riskFor(a.name).includes("destructive")).map((a) => a.name);
    if (offenders.length > 0) {
      reasons.push(`noDestructive: proposed destructive action(s) [${offenders.join(", ")}]`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}
