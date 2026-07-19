import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ENDPOINT_SCOPE_SOURCES, type ScopeAccess } from "../src/addon/scope-contract.js";
import { ACTION_CATALOG } from "../src/harness/catalog.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const clockifyRoot = resolve(repositoryRoot, "src/clockify");
const restRoot = resolve(repositoryRoot, "src/clockify/rest");
const outputPath = resolve(repositoryRoot, "docs/ENDPOINT_SCOPE_CONTRACT.md");
const CORE_METHODS = new Set(["call", "mutate", "paginate", "paginateEnvelope", "getBinary"]);

interface AdapterEndpoint {
  access: ScopeAccess;
  host: string;
  method: string;
  path: string;
  source: string;
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

function assertNoEscapedRestCoreCallsites(): void {
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

function extractAdapterEndpoints(): AdapterEndpoint[] {
  assertNoEscapedRestCoreCallsites();
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
        const method = direct
          ? stringArgument(node.arguments[1], source, "method").toUpperCase()
          : "GET";
        if (operation === "call" && method !== "GET" && method !== "POST") {
          throw new Error(`${source.fileName}: core.call cannot carry a mutation method (${method}); use core.mutate`);
        }
        const pathNode = node.arguments[direct ? 2 : 1];
        if (!pathNode) throw new Error(`${source.fileName}: RestCore call is missing a path`);
        extracted.push({
          access: operation === "mutate" ? "write" : "read",
          host,
          method,
          path: normalizedPath(pathNode, source),
          source: filename,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const unique = new Map<string, AdapterEndpoint>();
  for (const endpoint of extracted) {
    const key = [endpoint.access, endpoint.host, endpoint.method, endpoint.path, endpoint.source].join("\u0000");
    unique.set(key, endpoint);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.source} ${left.host} ${left.method} ${left.path}`.localeCompare(
      `${right.source} ${right.host} ${right.method} ${right.path}`,
    ));
}

function render(): string {
  const adapterEndpoints = extractAdapterEndpoints();
  const catalogGroups = new Map<string, string[]>();
  for (const action of ACTION_CATALOG) {
    const names = catalogGroups.get(action.featureGroup) ?? [];
    names.push(action.name);
    catalogGroups.set(action.featureGroup, names);
  }

  const assignments = new Map<AdapterEndpoint, string[]>();
  const rows = ENDPOINT_SCOPE_SOURCES.map((source) => {
    const patterns = source.pathPatterns.map((pattern) => new RegExp(pattern));
    const endpoints = adapterEndpoints.filter((endpoint) =>
      endpoint.access === source.access
      && source.adapterModules.includes(endpoint.source)
      && patterns.some((pattern) => pattern.test(endpoint.path)),
    );
    if (endpoints.length === 0) {
      throw new Error(`${source.scope}: retained scope has no matching adapter endpoint`);
    }
    for (const endpoint of endpoints) {
      const scopes = assignments.get(endpoint) ?? [];
      scopes.push(source.scope);
      assignments.set(endpoint, scopes);
    }

    const catalogActions = source.catalogFeatureGroups.flatMap((group) => {
      const names = catalogGroups.get(group);
      if (!names?.length) throw new Error(`${source.scope}: catalog feature group ${group} is empty or unknown`);
      return names;
    });
    const exactEndpoints = [...new Set(endpoints.map((endpoint) =>
      `${endpoint.host.toUpperCase()} ${endpoint.method} ${endpoint.path}`,
    ))].sort();
    return `| \`${source.scope}\` | ${exactEndpoints.map((endpoint) => `\`${endpoint}\``).join("<br>")} | ${source.catalogFeatureGroups.map((group) => `\`${group}\``).join(", ")} (${new Set(catalogActions).size} actions) | ${source.probes.map((probe) => `\`${probe}\``).join("<br>")} |`;
  });

  const unassigned = adapterEndpoints.filter((endpoint) => !assignments.has(endpoint));
  if (unassigned.length > 0) {
    throw new Error(
      `Adapter endpoints without a retained scope:\n${unassigned.map((endpoint) =>
        `- ${endpoint.source}: ${endpoint.access} ${endpoint.host.toUpperCase()} ${endpoint.method} ${endpoint.path}`,
      ).join("\n")}`,
    );
  }
  const multiplyAssigned = [...assignments.entries()].filter(([, scopes]) => scopes.length !== 1);
  if (multiplyAssigned.length > 0) {
    throw new Error(
      `Adapter callsites assigned to multiple retained scopes:\n${multiplyAssigned.map(([endpoint, scopes]) =>
        `- ${endpoint.source}: ${endpoint.access} ${endpoint.host.toUpperCase()} ${endpoint.method} ${endpoint.path} -> ${scopes.join(", ")}`,
      ).join("\n")}`,
    );
  }
  const retainedScopes = ENDPOINT_SCOPE_SOURCES.map(({ scope }) => scope);
  if (new Set(retainedScopes).size !== retainedScopes.length) {
    throw new Error("Retained scope declarations must be unique");
  }

  return [
    "<!-- GENERATED by scripts/generate-endpoint-scope-contract.ts; do not edit manually. -->",
    "# Endpoint-to-scope contract",
    "",
    "This contract is extracted from the actual `src/clockify/rest/*.ts` `RestCore` calls and cross-checked against the assembled `ACTION_CATALOG`. Generation first rejects any `RestCore` callsite outside that scanned adapter root and rejects mutation HTTP methods routed through read-only `core.call`. Each assignment is adapter callsite-specific (`access + host + method + normalized path + source module`) and generation fails if a callsite is unassigned or assigned to more than one retained scope, a retained scope has no exact endpoint, a catalog group is missing, or this artifact drifts. The same wire path may appear in different source modules when Clockify applies permission semantics to the operation/payload. Catalog groups are a conservative potential-consumer cross-check; they are not claimed as exact per-action call edges.",
    "",
    "`REPORTS_READ` covers POST search requests on the reports host. The add-on declares no `REPORTS_WRITE`: no report mutation exists in the adapter or catalog. `WORKSPACE_READ`/`WORKSPACE_WRITE` cover the Clockify endpoint families (workspace settings, holidays, webhooks, entity changes, and audit search) for which the SDK exposes no narrower manifest scope.",
    "",
    "Clockify's add-on authorization contract defines scopes as resource + READ/WRITE permissions and states that an endpoint called without its appropriate declared scope fails with HTTP 403. The release gate combines that platform rule with this exact one-to-one adapter assignment and `scripts/live-scope-probe.ts` against a newly issued production add-on token: every retained scope must have one distinct exact endpoint probe which clears authorization. Static extraction alone is not treated as live permission evidence.",
    "",
    `Generated inventory: **${adapterEndpoints.length} distinct adapter request shapes**, **${ACTION_CATALOG.length} catalog actions**, **${ENDPOINT_SCOPE_SOURCES.length} retained scopes**.`,
    "",
    "| Scope | Exact adapter request shape(s) | Potential catalog feature groups | Offline request-shape probe(s) |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

const expected = render();
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== expected) {
    throw new Error(`Endpoint scope contract is stale; run npm run generate:scope-contract (${basename(outputPath)}).`);
  }
} else {
  writeFileSync(outputPath, expected, "utf8");
}
