import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { requireSessionCookie, requireSessionSetCookie } from "../helpers/session.js";

const LOCAL_ONLY_SCRIPT_PATHS = new Set(["scripts/user-sim.ts"]);

function typescriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

function isEmptyString(node: ts.Node): boolean {
  return (
    ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
  ) && node.text === "";
}

function lineOf(tree: ts.SourceFile, node: ts.Node): number {
  return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
}

function repositoryPath(path: string): string {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

function findSilentEmptyCookieFallbacks(path: string, source: string): string[] {
  const offenders: string[] = [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    const isConditionalFallback = ts.isConditionalExpression(node)
      && (isEmptyString(node.whenTrue) || isEmptyString(node.whenFalse));
    const isBinaryFallback = ts.isBinaryExpression(node)
      && (
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      )
      && isEmptyString(node.right);
    const isHistoricalStructuralPattern = ts.isConditionalExpression(node)
      && node.condition.getText(tree).includes("Array.isArray")
      && (
        node.whenTrue.getText(tree).includes(".split(")
        || node.whenFalse.getText(tree).includes(".split(")
      );
    const cookiePattern = /(?:cookie|set-cookie|ai_assistant_session)/iu;
    const namesCookieSource = cookiePattern.test(node.getText(tree))
      || (node.parent !== undefined && cookiePattern.test(node.parent.getText(tree)));
    if (
      (isConditionalFallback || isBinaryFallback)
      && (isHistoricalStructuralPattern || namesCookieSource)
    ) {
      offenders.push(`${repositoryPath(path)}:${String(lineOf(tree, node))}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return offenders;
}

describe("deterministic integration-test session bootstrap", () => {
  it("requires a real session cookie when an HTTP response is part of the behavior under test", () => {
    expect(requireSessionCookie({ "set-cookie": ["ai_assistant_session=signed; HttpOnly"] }))
      .toBe("ai_assistant_session=signed");
    expect(requireSessionSetCookie({ "set-cookie": "ai_assistant_session=signed; HttpOnly" }))
      .toBe("ai_assistant_session=signed; HttpOnly");
    expect(() => requireSessionCookie({})).toThrow(/Set-Cookie/);
    expect(() => requireSessionCookie({ "set-cookie": "other=value; HttpOnly" })).toThrow(/Set-Cookie/);
    expect(() => requireSessionCookie({ "set-cookie": "ai_assistant_session=; HttpOnly" })).toThrow(/non-empty/);
    expect(requireSessionCookie({
      "set-cookie": ["other=value; HttpOnly", "ai_assistant_session=second; HttpOnly"],
    })).toBe("ai_assistant_session=second");
  });

  it("forbids silent empty-cookie fallbacks in integration tests and operational scripts", () => {
    const roots = [join(process.cwd(), "tests", "integration"), join(process.cwd(), "scripts")];
    const offenders: string[] = [];
    for (const path of roots.flatMap(typescriptFiles)
      .filter((path) => !LOCAL_ONLY_SCRIPT_PATHS.has(repositoryPath(path)))) {
      const source = readFileSync(path, "utf8");
      offenders.push(...findSilentEmptyCookieFallbacks(path, source));
    }
    expect(offenders).toEqual([]);
  });

  it("detects the historical alias and operator variants", () => {
    const badSources = [
      'const sc = response.headers["set-cookie"]; const value = Array.isArray(sc) ? sc[0].split(";")[0] : "";',
      'const sc2 = response.headers["set-cookie"] ?? "";',
      'const header = response.headers["set-cookie"] || "";',
      'const cookie = available ? signed : "";',
      'const value = !Array.isArray(sc) ? `` : sc[0].split(";")[0];',
    ];
    for (const [index, source] of badSources.entries()) {
      expect(findSilentEmptyCookieFallbacks(`canary-${String(index)}.ts`, source))
        .toEqual([`canary-${String(index)}.ts:1`]);
    }
    expect(findSilentEmptyCookieFallbacks(
      "benign.ts",
      'const baseUrl = process.env.BASE_URL ?? "";',
    )).toEqual([]);
  });

  it("limits integration-test component bootstrap to component semantics", () => {
    const root = join(process.cwd(), "tests", "integration");
    const allowed = new Set([
      "tests/integration/chat-history.test.ts",
      "tests/integration/component-headers.test.ts",
      "tests/integration/routes.test.ts",
    ]);
    const offenders: string[] = [];
    for (const path of typescriptFiles(root)) {
      const source = readFileSync(path, "utf8");
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const file = repositoryPath(path);
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
          && node.text.includes("/component/assistant")
          && !allowed.has(file)
        ) {
          offenders.push(`${file}:${String(lineOf(tree, node))}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(offenders).toEqual([]);
  });
});
