import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const readScript = (name: string): string => readFileSync(
  fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url)),
  "utf8",
);

describe("live script evidence contract", () => {
  it.each([
    ["live-smoke.ts", "LIVE_SMOKE_EVIDENCE_PATH"],
    ["live-sweep.ts", "LIVE_SWEEP_EVIDENCE_PATH"],
  ])("writes sanitized pass and failure evidence from %s", (name, evidencePathVariable) => {
    const script = readScript(name);

    expect(script).toContain("writeLiveEvidence");
    expect(script).toContain(evidencePathVariable);
    expect(script).toMatch(/\.then\([\s\S]*?writeLiveEvidence[\s\S]*?\.catch\([\s\S]*?writeLiveEvidence/);
  });

  it("does not place live identities, names, payloads, or response bodies in smoke logs", () => {
    const script = readScript("live-smoke.ts");

    expect(script).toMatch(
      /const status = await executeAction[\s\S]*?if \(status\.kind !== "receipt" \|\| !status\.receipt\.ok\) throw new Error/,
    );
    expect(script).not.toMatch(/console\.(?:log|warn|error)\([^\n]*(?:WORKSPACE_ID|\.id|\.name|JSON\.stringify)/);
    expect(script).not.toMatch(/throw new Error\([^\n]*(?:path|JSON\.stringify|res\.text)/);
    expect(script).toContain("let remainingCount: number | undefined;");
  });

  it("fails sweep evidence when any attempted cleanup fails", () => {
    const script = readScript("live-sweep.ts");

    expect(script).toContain("cleanupFailures");
    expect(script).toContain("scanFailures");
    expect(script).toContain("const failures = cleanupFailures + scanFailures;");
    expect(script).toMatch(/if \(failures > 0\) throw new Error/);
    expect(script).not.toContain('call("GET", "/user").catch(() => null)');
    expect(script).toMatch(
      /async function scanRows[\s\S]*?catch \{\s*scanFailures\+\+;\s*return \[\];/,
    );
    expect(script).not.toMatch(/console\.(?:log|warn|error)\([^\n]*(?:\.id|\.name|\.number|\.notes)/);
  });
});
