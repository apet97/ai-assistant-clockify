import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_SCHEMA_KEYS } from "../../src/config.js";

/**
 * Pins the README's "See .env.example for the full list" claim: every env var
 * the Zod schema (src/config.ts) accepts must appear in the template, either as
 * a required uncommented entry or a commented optional knob. Without this, new
 * schema keys (e.g. LLM_AGENTIC -- the documented single-turn rollback switch)
 * silently never reach the env template a new operator copies.
 */
const envExamplePath = fileURLToPath(new URL("../../.env.example", import.meta.url));

function templateKeys(): Set<string> {
  const text = readFileSync(envExamplePath, "utf8");
  const keys = new Set<string>();
  // Matches "FOO=" and commented "# FOO=" lines.
  const re = /^#? ?([A-Z0-9_]+)=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

describe(".env.example template", () => {
  it("documents every env var the config schema accepts", () => {
    const documented = templateKeys();
    const missing = ENV_SCHEMA_KEYS.filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });
});
