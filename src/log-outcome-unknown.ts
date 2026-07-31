/**
 * The operator lines for the `outcome_unknown` terminal state (D2).
 *
 * `outcome_unknown` means the write was dispatched but Clockify never proved
 * whether it applied — the one terminal state that needs a human to go look.
 * `DEPLOYMENT.md` ("Required alerts") requires alerting on it. The UI already
 * renders it for the admin who caused it, but nothing reached the operator, and
 * in the metrics aggregate it was folded into `failed`, so a run of ambiguity
 * was indistinguishable from clean rejection.
 *
 * Both events share the literal prefix `[write-outcome] event=outcome_unknown`,
 * so a single operator match string catches settlement AND restart recovery.
 *
 * The line carries the action name, the server-minted operation id, and — only
 * where a session secret is already in scope — an HMAC workspace alias
 * (`src/log-alias.ts`), never a raw workspace id. It carries no payload, no
 * error message, and no admin-authored text. Two deliberate limitations:
 *
 * - `workspace=` is absent at seams with no reachable session secret: the
 *   harness settlement path, and restart recovery (which spans every
 *   workspace). A secret is NOT threaded into `src/harness/` just to log.
 * - The operation id is NOT an operator lookup key.
 *   `GET /api/operation-runs/:operationId` (`src/routes/operations.ts:39-51`)
 *   requires a session and scopes on workspace + admin + session, so it 404s
 *   for anyone but the causing admin in the causing session. Without the alias
 *   suffix the line therefore says THAT an ambiguous write happened and WHICH
 *   action — not which workspace; the id only correlates lines to each other.
 */
export function logOutcomeUnknown(input: {
  /** The action name — server-controlled, never model- or admin-authored. */
  action: string;
  /** The server-minted operation UUID; correlates lines, not an operator lookup key. */
  operationId: string;
  /** `logAlias(secret, "workspace", id)`; omitted where no secret is in scope. */
  workspaceAlias?: string;
  log?: (line: string) => void;
}): void {
  const log = input.log ?? ((line: string) => console.warn(line));
  const workspace = input.workspaceAlias ? ` workspace=${input.workspaceAlias}` : "";
  log(
    `[write-outcome] event=outcome_unknown action=${input.action} operation=${input.operationId}${workspace}`,
  );
}

/**
 * Restart/restore recovery settled ambiguous rows (`recoverOrphanedRuns`) — the
 * path `DEPLOYMENT.md` names as what produces `outcome_unknown` after a
 * point-in-time restore.
 *
 * This is ONE aggregate line, not one per row, deliberately: recovery runs at
 * store construction before traffic is accepted, and its row count is bounded
 * only by how much work was in flight across every workspace when the process
 * died, so per-row output would be an unbounded startup log burst — itself an
 * incident. Counts answer the alert question ("did this restart strand
 * ambiguous effects, and how many?"); the per-row detail is already durable in
 * the operation journal. For the same reason it carries no workspace alias: the
 * rows span workspaces, and no session secret is in scope at store construction.
 *
 * `steps` is the stranded HOST EFFECT count — the unit DEPLOYMENT.md names —
 * and `operations` the parent rows settled ambiguous. They are reported side by
 * side rather than summed because one stranded effect normally settles both,
 * and either can be non-zero alone.
 */
export function logOutcomeUnknownRecovered(input: {
  steps: number;
  operations: number;
  log?: (line: string) => void;
}): void {
  const log = input.log ?? ((line: string) => console.warn(line));
  log(
    `[write-outcome] event=outcome_unknown_recovered steps=${input.steps} operations=${input.operations}`,
  );
}
