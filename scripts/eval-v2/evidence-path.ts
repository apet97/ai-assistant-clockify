import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Plan B4 — the ONE evidence-path contract shared by the three v2 evals
 * (`eval:api-discovery`, `eval:assistant-terminal`, `eval:write-safety`).
 *
 * Each eval declares exactly one environment variable
 * (`EVAL_<NAME>_EVIDENCE_PATH`). When it is set, the eval's JSON report is
 * ALSO written to that exact path: ONE serialization feeds both sinks, so the
 * file is byte-identical to what the operator saw on stdout. The file is
 * created with mode 0600 (mirroring the `scripts/evidence/` conventions:
 * two-space-indented JSON with a trailing newline, as in
 * `scripts/evidence/write-json.ts`), and an EXISTING file is refused with a
 * loud error rather than replaced — recorded evidence must never be silently
 * overwritten. Before this contract the evals were stdout-only and the
 * `ad06c08` diagnostic survived only as redirected stdout.
 */

export interface EvalEvidenceSink {
  /** The exact environment variable that declares the path — named in error copy. */
  variable: string;
  /** The declared destination; `undefined` disables the file sink. */
  path: string | undefined;
}

/** Resolve an eval's sink from the ambient environment; empty means unset. */
export function evalEvidenceSink(variable: string): EvalEvidenceSink {
  const declared = process.env[variable];
  return { variable, path: declared === undefined || declared === "" ? undefined : declared };
}

/** The ONE deterministic serialization both sinks receive. */
export function serializeEvalReport(report: unknown): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Print the serialized report to stdout and, when a path is declared, persist
 * the SAME bytes to it. stdout comes first so a refused file write can never
 * lose the report of a completed (possibly credentialed) run; the refusal then
 * throws, which exits the eval nonzero.
 */
export function emitEvalReport(
  report: unknown,
  sink: EvalEvidenceSink,
  stdout: { write(chunk: string): unknown } = process.stdout,
): void {
  const serialized = serializeEvalReport(report);
  stdout.write(serialized);
  if (sink.path === undefined) return;
  writeEvidenceFile(sink.variable, sink.path, serialized);
}

function writeEvidenceFile(variable: string, path: string, serialized: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    // `wx` is create-or-fail: an existing file is never truncated or replaced.
    writeFileSync(path, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `${variable}=${path} already exists; refusing to overwrite recorded evidence. `
        + "Move the existing file aside or declare a fresh path.",
      );
    }
    throw error;
  }
  // The create-time mode is masked by the process umask; make 0600 unconditional.
  chmodSync(path, 0o600);
}
