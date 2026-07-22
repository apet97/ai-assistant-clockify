import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

import type { ScopeAccess } from "../../src/addon/scope-contract.js";

const CORE_METHODS = new Set([
  "call",
  "postQuery",
  "mutate",
  "paginate",
  "paginateEnvelope",
  "getBinary",
]);

export type AdapterEndpointPagination = "none" | "plain" | "envelope";

export interface AdapterEndpoint {
  access: ScopeAccess;
  host: string;
  method: string;
  rawPath: string;
  sourceModule: string;
  sourceLine: number;
  pagination: AdapterEndpointPagination;
}

function lastIdentifier(text: string): string {
  const identifiers = text.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return identifiers.at(-1) ?? "value";
}

function normalizedPath(node: ts.Expression, source: ts.SourceFile): string {
  if (ts.isIdentifier(node) && node.text === "ws") return "/workspaces/{workspaceId}";
  if (ts.isStringLiteralLike(node)) return node.text.split("?", 1)[0] ?? node.text;
  if (!ts.isTemplateExpression(node)) {
    throw new Error(`${source.fileName}: RestCore path must be a literal/template, got ${node.getText(source)}`);
  }

  let value = node.head.text;
  for (const span of node.templateSpans) {
    const expression = span.expression.getText(source);
    if (expression === "ws") {
      value += "/workspaces/{workspaceId}";
    } else if (!/(?:^|\.)qs(?:\.|$)|URLSearchParams|toString\(\)/.test(expression)) {
      value += `{${lastIdentifier(expression)}}`;
    }
    value += span.literal.text;
  }
  return value.split("?", 1)[0] ?? value;
}

function stringArgument(node: ts.Expression | undefined, source: ts.SourceFile, label: string): string {
  if (node && ts.isStringLiteralLike(node)) return node.text;
  throw new Error(`${source.fileName}: RestCore ${label} must be a string literal`);
}

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function isRestCoreCall(
  node: ts.Node,
  source: ts.SourceFile,
): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText(source) === "core"
    && CORE_METHODS.has(node.expression.name.text);
}

function assertNoEscapedRestCoreCallsites(
  repositoryRoot: string,
  clockifyRoot: string,
  restRoot: string,
): void {
  for (const absolutePath of typescriptFiles(clockifyRoot)) {
    if (absolutePath.startsWith(`${restRoot}/`)) continue;
    const source = ts.createSourceFile(
      absolutePath,
      readFileSync(absolutePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (isRestCoreCall(node, source)) {
        throw new Error(
          `${relative(repositoryRoot, absolutePath)}: RestCore callsite outside scanned adapter root`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

function paginationFor(operation: string): AdapterEndpointPagination {
  if (operation === "paginate") return "plain";
  if (operation === "paginateEnvelope") return "envelope";
  return "none";
}

export function adapterEndpointKey(endpoint: AdapterEndpoint): string {
  return [
    endpoint.access,
    endpoint.host,
    endpoint.method,
    endpoint.rawPath,
    endpoint.sourceModule,
  ].join("\u0000");
}

export function extractAdapterEndpoints(repositoryRoot: string): AdapterEndpoint[] {
  const clockifyRoot = resolve(repositoryRoot, "src/clockify");
  const restRoot = resolve(clockifyRoot, "rest");
  assertNoEscapedRestCoreCallsites(repositoryRoot, clockifyRoot, restRoot);

  const extracted: AdapterEndpoint[] = [];
  for (const filename of readdirSync(restRoot).filter((name) => name.endsWith(".ts")).sort()) {
    const absolutePath = resolve(restRoot, filename);
    const source = ts.createSourceFile(
      absolutePath,
      readFileSync(absolutePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (isRestCoreCall(node, source)) {
        const operation = node.expression.name.text;
        const direct = operation === "call" || operation === "mutate";
        const host = stringArgument(node.arguments[0], source, "host");
        const method = operation === "postQuery"
          ? "POST"
          : direct
            ? stringArgument(node.arguments[1], source, "method").toUpperCase()
            : "GET";
        if (operation === "call" && !["GET", "HEAD", "OPTIONS"].includes(method)) {
          throw new Error(
            `${source.fileName}: core.call requires a safe read method (${method}); use core.postQuery or core.mutate`,
          );
        }
        const pathNode = node.arguments[direct ? 2 : 1];
        if (!pathNode) throw new Error(`${source.fileName}: RestCore call is missing a path`);
        extracted.push({
          access: operation === "mutate" ? "write" : "read",
          host,
          method,
          rawPath: normalizedPath(pathNode, source),
          sourceModule: filename,
          sourceLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          pagination: paginationFor(operation),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const unique = new Map<string, AdapterEndpoint>();
  for (const endpoint of extracted) unique.set(adapterEndpointKey(endpoint), endpoint);
  return [...unique.values()].sort((left, right) =>
    `${left.sourceModule} ${left.host} ${left.method} ${left.rawPath}`.localeCompare(
      `${right.sourceModule} ${right.host} ${right.method} ${right.rawPath}`,
    ));
}

export function correlateAdapterEndpointPaths(
  rawPath: string,
  normalizePlaceholderNames: (path: string) => string,
  expandDynamicLiterals: (path: string) => readonly string[],
): string[] {
  return [...new Set(expandDynamicLiterals(rawPath).map(normalizePlaceholderNames))].sort();
}
