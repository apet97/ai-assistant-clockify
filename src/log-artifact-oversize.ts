/**
 * The operator line for a rejected oversize artifact (D3; `DEPLOYMENT.md`
 * "Required alerts" row 8).
 *
 * An invoice PDF over the 1,000,000-byte cap is refused at three independent
 * points — the bounded binary download, the pre-persistence guard in the export
 * action, and the store's own limit. All three were silent: the admin saw a
 * receipt, and the operator saw nothing, so "exports started failing after
 * Clockify changed its PDF layout" was invisible until someone complained.
 *
 * The line carries only sizes and which guard fired. It carries NO workspace,
 * admin, session, invoice id, or filename: the two emitting seams are the store
 * builder and a harness action, neither of which has a session secret in scope
 * to alias an identifier with — and a secret is not threaded into `src/db/` or
 * `src/harness/` merely to log. A filename is doubly excluded: it is
 * server-built from an entity id today, but it is exactly the field a future
 * caller would make user-controlled.
 */
/**
 * Which guard refused. All three caps are the SAME 1,000,000 bytes, so in
 * production only `download` is reachable: the adapter's bounded binary GET
 * refuses first and the export never returns bytes for the others to inspect.
 * The other two are defence in depth, not live paths — `export` covers an
 * alternate (non-REST) `WorkspaceClient`, and `persist` covers a caller that
 * reaches the store without the harness guard ahead of it. Seeing either in a
 * production log means something upstream is not what it is assumed to be.
 */
export type ArtifactOversizeSite =
  /** The adapter's bounded binary GET. The only production-reachable guard. */
  | "download"
  /** The export action's guard — only reachable for a non-REST WorkspaceClient. */
  | "export"
  /** The store's own limit — only reachable by bypassing the harness guard. */
  | "persist";

export function logArtifactOversizeRejected(input: {
  site: ArtifactOversizeSite;
  limitBytes: number;
  /**
   * Omitted ONLY where the size is genuinely unknown — the streaming branch of
   * the adapter cap, which cancels mid-body and therefore has a lower bound
   * rather than a measurement. The declared-Content-Length and fully-buffered
   * branches both know the real size and pass it. Reporting a bound as if it
   * were a measurement would be a lie; dropping a size we had was a waste.
   */
  bytes?: number;
  log?: (line: string) => void;
}): void {
  const log = input.log ?? ((line: string) => console.warn(line));
  const bytes = input.bytes === undefined ? "" : ` bytes=${input.bytes}`;
  log(
    `[storage] event=artifact_oversize_rejected site=${input.site} limit=${input.limitBytes}${bytes}`,
  );
}
