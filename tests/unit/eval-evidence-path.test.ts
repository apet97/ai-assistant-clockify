import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  emitEvalReport,
  evalEvidenceSink,
  serializeEvalReport,
} from "../../scripts/eval-v2/evidence-path.js";
import { main as apiDiscoveryMain } from "../../scripts/eval-api-discovery.js";
import { main as assistantTerminalMain } from "../../scripts/eval-assistant-terminal.js";
import { main as writeSafetyMain } from "../../scripts/eval-write-safety.js";

/**
 * Plan B4: the per-eval evidence-path contract. Before this change all three
 * v2 evals were stdout-only — the ad06c08 diagnostic survived only as
 * redirected stdout. The ONE shared helper (`scripts/eval-v2/evidence-path.ts`)
 * serializes the report exactly once and feeds two sinks: stdout always, and
 * the file declared by the eval's `*_EVIDENCE_PATH` variable when set — mode
 * 0600, refusing to overwrite an existing file. Nothing here (or in the
 * credential-less eval mains) makes a provider call.
 */

const REPORT_FIXTURE = {
  schemaVersion: 1,
  kind: "b4_fixture",
  status: "failed",
  nested: { caseIds: ["b", "a"], unicode: "č — data, not instructions" },
};

function tempEvidencePath(prefix: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return { directory, path: join(directory, "nested", "report.json") };
}

function captureSink(): { chunks: string[]; sink: { write(chunk: string): unknown } } {
  const chunks: string[] = [];
  return { chunks, sink: { write: (chunk: string) => chunks.push(chunk) } };
}

describe("eval evidence path helper", () => {
  it("serializes deterministically: same report, same exact bytes, trailing newline", () => {
    const first = serializeEvalReport(REPORT_FIXTURE);
    const second = serializeEvalReport(REPORT_FIXTURE);
    expect(first).toBe(second);
    expect(first).toBe(`${JSON.stringify(REPORT_FIXTURE, null, 2)}\n`);
    expect(first.endsWith("\n")).toBe(true);
  });

  it("feeds both sinks from ONE serialization and creates the file with mode 0600", () => {
    const { directory, path } = tempEvidencePath("eval-evidence-0600-");
    const { chunks, sink } = captureSink();
    try {
      emitEvalReport(REPORT_FIXTURE, { variable: "EVAL_B4_TEST_EVIDENCE_PATH", path }, sink);

      const written = readFileSync(path, "utf8");
      expect(chunks.join("")).toBe(serializeEvalReport(REPORT_FIXTURE));
      expect(written).toBe(chunks.join(""));
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing file loudly and leaves the original bytes intact", () => {
    const { directory, path } = tempEvidencePath("eval-evidence-refuse-");
    const { chunks, sink } = captureSink();
    try {
      emitEvalReport(REPORT_FIXTURE, { variable: "EVAL_B4_TEST_EVIDENCE_PATH", path }, sink);
      const original = readFileSync(path, "utf8");

      const replacement = { ...REPORT_FIXTURE, status: "passed" };
      expect(() => emitEvalReport(replacement, { variable: "EVAL_B4_TEST_EVIDENCE_PATH", path }, sink))
        .toThrow(/EVAL_B4_TEST_EVIDENCE_PATH.*refusing to overwrite/s);

      // The recorded evidence is untouched; stdout still received the second report.
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(chunks.join("")).toBe(
        serializeEvalReport(REPORT_FIXTURE) + serializeEvalReport(replacement),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prints to stdout only when no path is declared", () => {
    const { directory, path } = tempEvidencePath("eval-evidence-unset-");
    const { chunks, sink } = captureSink();
    try {
      emitEvalReport(REPORT_FIXTURE, { variable: "EVAL_B4_TEST_EVIDENCE_PATH", path: undefined }, sink);
      expect(chunks.join("")).toBe(serializeEvalReport(REPORT_FIXTURE));
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves the sink from the exact environment variable, treating empty as unset", () => {
    const variable = "EVAL_B4_TEST_EVIDENCE_PATH";
    const previous = process.env[variable];
    try {
      process.env[variable] = "/tmp/declared/evidence.json";
      expect(evalEvidenceSink(variable)).toEqual({ variable, path: "/tmp/declared/evidence.json" });

      process.env[variable] = "";
      expect(evalEvidenceSink(variable).path).toBeUndefined();

      delete process.env[variable];
      expect(evalEvidenceSink(variable)).toEqual({ variable, path: undefined });
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });
});

/**
 * Wiring: each eval main, run without credentials (its fast, provider-free
 * missing-credential path), must persist byte-identical evidence to its
 * declared path while still printing the full report to stdout — and must
 * refuse a second write to the same path.
 */
describe("eval mains honour their evidence-path variable", () => {
  const CREDENTIAL_KEYS = ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const;

  const EVALS: ReadonlyArray<{
    name: string;
    variable: string;
    run: () => Promise<void>;
  }> = [
    {
      name: "eval-api-discovery",
      variable: "EVAL_API_DISCOVERY_EVIDENCE_PATH",
      run: async () => apiDiscoveryMain(),
    },
    {
      name: "eval-assistant-terminal",
      variable: "EVAL_ASSISTANT_TERMINAL_EVIDENCE_PATH",
      run: async () => assistantTerminalMain(),
    },
    {
      name: "eval-write-safety",
      variable: "EVAL_WRITE_SAFETY_EVIDENCE_PATH",
      run: async () => { writeSafetyMain(); },
    },
  ];

  it.each(EVALS)("$name writes stdout-identical JSON to $variable and refuses a rerun", async ({ variable, run }) => {
    const { directory, path } = tempEvidencePath("eval-main-evidence-");
    const savedEnvironment = new Map<string, string | undefined>();
    for (const key of [...CREDENTIAL_KEYS, variable]) {
      savedEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env[variable] = path;
    const previousExitCode = process.exitCode;
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    try {
      await run();

      // A credential-less run is never releasable; the eval stays nonzero.
      expect(process.exitCode).toBe(2);
      const printed = chunks.join("");
      const written = readFileSync(path, "utf8");
      expect(written).toBe(printed);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const parsed = JSON.parse(written) as { status?: string };
      expect(parsed.status).toBe("not_evaluated_missing_credentials");

      // A second run must refuse the already-recorded evidence file loudly.
      await expect(run()).rejects.toThrow(new RegExp(`${variable}.*refusing to overwrite`, "s"));
      expect(readFileSync(path, "utf8")).toBe(written);
    } finally {
      stdoutSpy.mockRestore();
      process.exitCode = previousExitCode;
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
