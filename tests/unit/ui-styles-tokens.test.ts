import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the theme-token system: every `var(--token)` reference in the UI
 * stylesheet must point at a custom property that is actually defined
 * somewhere in the same file. An undefined token silently falls back to its
 * inline literal (or nothing), escaping the light/dark theme system -- which
 * is how `.typing-label` shipped a hardcoded `#6b7280` behind an undefined
 * `--text-muted` and rendered below the WCAG AA contrast threshold in dark
 * mode (finding r1-ux-copy-a11y-05).
 */
const stylesPath = fileURLToPath(new URL("../../src/ui/styles.css", import.meta.url));

function definedTokens(css: string): Set<string> {
  const tokens = new Set<string>();
  // A custom-property declaration: `  --foo: value;` (not inside a var() call).
  const re = /(?:^|[;{])\s*(--[a-z0-9-]+)\s*:/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    tokens.add(m[1]);
  }
  return tokens;
}

function referencedTokens(css: string): string[] {
  const refs: string[] = [];
  // A `var(--foo)` or `var(--foo, fallback)` usage -- capture the token name.
  const re = /var\(\s*(--[a-z0-9-]+)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    refs.push(m[1]);
  }
  return refs;
}

describe("UI stylesheet theme tokens", () => {
  it("references no undefined custom property", () => {
    const css = readFileSync(stylesPath, "utf8");
    const defined = definedTokens(css);
    const undefinedRefs = [...new Set(referencedTokens(css))].filter(
      (token) => !defined.has(token),
    );
    expect(undefinedRefs).toEqual([]);
  });
});
