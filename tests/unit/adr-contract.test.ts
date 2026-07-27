import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const adrRelativePath = "docs/adr/001-api-agent-v2.md";
const adrPath = `${repositoryRoot}/${adrRelativePath}`;
const freezeRule =
  "During coexistence, v1 accepts only critical safety, production, and verified Clockify-contract fixes.";

describe("API agent v2 architecture documentation contract", () => {
  it("publishes ADR 001 and freezes v1 in every contributor entry point", () => {
    const missing: string[] = [];

    if (!existsSync(adrPath)) {
      missing.push(adrRelativePath);
    }

    for (const relativePath of ["README.md", "CLAUDE.md", "AGENTS.md"] as const) {
      const contents = readFileSync(`${repositoryRoot}/${relativePath}`, "utf8");
      if (!contents.includes(adrRelativePath)) {
        missing.push(`${relativePath}: ADR 001 pointer`);
      }
      if (!contents.includes(freezeRule)) {
        missing.push(`${relativePath}: v1 freeze rule`);
      }
    }

    expect(missing).toEqual([]);
  });
});
