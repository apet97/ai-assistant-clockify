import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

import type { ScopeAccess } from "../../src/addon/scope-contract.js";
import type {
  ApiHost,
  ApiMethod,
  AvailabilityByAuthClass,
} from "../../src/harness/api-operation.js";

export const OFFICIAL_OPENAPI_SOURCE = Object.freeze({
  version: "v1",
  sha256: "044e2d2e3de91325c0ac26ab84dfe676d6a36432d678cced8ea8f37a3a640de2",
  corroborationPath: "evidence/openapi/clockify.official.openapi.yaml",
});

export interface CanonicalOpenApiOperation {
  host: ApiHost;
  method: ApiMethod;
  path: string;
  operationId: string;
}

/**
 * Official operations consumed only by current internal actions. Atomic API
 * actions carry their own reviewed operation metadata; this table closes the
 * remaining raw-adapter correlation surface without making those actions
 * model-visible before Task 6.
 */
export const INTERNAL_OPENAPI_OPERATIONS = [
  { host: "api", method: "DELETE", path: "/workspaces/{workspaceId}/clients/{id}", operationId: "deleteClient" },
  { host: "api", method: "GET", path: "/workspaces/{workspaceId}/entities/created", operationId: "getCreatedEntityInfo" },
  { host: "api", method: "GET", path: "/workspaces/{workspaceId}/entities/deleted", operationId: "getDeletedEntityInfo" },
  { host: "api", method: "GET", path: "/workspaces/{workspaceId}/entities/updated", operationId: "getUpdatedEntityInfo" },
  { host: "api", method: "GET", path: "/workspaces/{workspaceId}/scheduling/assignments/projects/totals/{projectId}", operationId: "getProjectTotalsForSingleProject" },
  { host: "api", method: "PATCH", path: "/workspaces/{workspaceId}/time-entries/invoiced", operationId: "updateInvoicedStatus" },
  { host: "api", method: "PATCH", path: "/workspaces/{workspaceId}/time-off/balance/policy/{policyId}", operationId: "updateBalance" },
  { host: "api", method: "POST", path: "/workspaces/{workspaceId}/clients", operationId: "createClient" },
  { host: "api", method: "POST", path: "/workspaces/{workspaceId}/scheduling/assignments/projects/totals", operationId: "getFilteredProjectTotals" },
  { host: "api", method: "POST", path: "/workspaces/{workspaceId}/time-entries", operationId: "createTimeEntry" },
  { host: "api", method: "POST", path: "/workspaces/{workspaceId}/time-off/policies", operationId: "createPolicy" },
  { host: "api", method: "POST", path: "/workspaces/{workspaceId}/user-groups/{userGroupId}/users", operationId: "addUser" },
  { host: "api", method: "PUT", path: "/workspaces/{workspaceId}/clients/{id}", operationId: "updateClient" },
  { host: "api", method: "PUT", path: "/workspaces/{workspaceId}/time-entries/{id}", operationId: "updateTimeEntry" },
  { host: "api", method: "PUT", path: "/workspaces/{workspaceId}/time-off/policies/{id}", operationId: "updatePolicy" },
] as const satisfies readonly CanonicalOpenApiOperation[];

export interface NonActionAdapterDisposition {
  adapterKey: string;
  decision: "internal_support";
  consumers: readonly string[];
  availabilityByAuthClass: AvailabilityByAuthClass;
  reason: string;
}

export const NON_ACTION_ADAPTER_DISPOSITIONS = [
  {
    adapterKey: [
      "read",
      "api",
      "GET",
      "/workspaces/{workspaceId}",
      "users.ts",
    ].join("\0"),
    decision: "internal_support",
    consumers: ["src/routes/chat-pipeline.ts", "src/routes/component.ts"],
    availabilityByAuthClass: {
      addon: { available: true },
      api_key: { available: true },
    },
    reason: "Loads the authenticated admin's calendar context before action selection; it is route support, not an action endpoint.",
  },
] as const satisfies readonly NonActionAdapterDisposition[];

type RestCoreOperation =
  | "call"
  | "postQuery"
  | "mutate"
  | "paginate"
  | "paginateEnvelope"
  | "getBinary";

const CORE_METHODS: readonly RestCoreOperation[] = [
  "call",
  "postQuery",
  "mutate",
  "paginate",
  "paginateEnvelope",
  "getBinary",
];

function isRestCoreOperation(value: string): value is RestCoreOperation {
  return CORE_METHODS.some((operation) => operation === value);
}

export type AdapterEndpointPagination = "none" | "plain" | "envelope";

export interface AdapterEndpoint {
  access: ScopeAccess;
  host: string;
  method: string;
  rawPath: string;
  sourceModule: string;
  sourceLine: number;
  sourceColumn: number;
  pagination: AdapterEndpointPagination;
}

export interface OpenApiDescriptionOperation {
  method: ApiMethod;
  path: string;
  operationId: string;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

type RestCoreCallExpression = ts.CallExpression & {
  expression: ts.PropertyAccessExpression & {
    name: ts.Identifier & { text: RestCoreOperation };
  };
};

function isRestCoreCall(
  node: ts.Node,
  source: ts.SourceFile,
): node is RestCoreCallExpression {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.name)
    && node.expression.expression.getText(source) === "core"
    && isRestCoreOperation(node.expression.name.text);
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

function paginationFor(operation: RestCoreOperation): AdapterEndpointPagination {
  switch (operation) {
    case "paginate": return "plain";
    case "paginateEnvelope": return "envelope";
    case "call":
    case "postQuery":
    case "mutate":
    case "getBinary": return "none";
  }
}

export function adapterRequestShapeKey(endpoint: AdapterEndpoint): string {
  return [
    endpoint.access,
    endpoint.host,
    endpoint.method,
    endpoint.rawPath,
    endpoint.sourceModule,
  ].join("\u0000");
}

export function adapterEndpointKey(endpoint: AdapterEndpoint): string {
  return [
    adapterRequestShapeKey(endpoint),
    endpoint.sourceLine,
    endpoint.sourceColumn,
    endpoint.pagination,
  ].join("\u0000");
}

export function extractAdapterEndpoints(repositoryRoot: string): AdapterEndpoint[] {
  const clockifyRoot = resolve(repositoryRoot, "src/clockify");
  const restRoot = resolve(clockifyRoot, "rest");
  assertNoEscapedRestCoreCallsites(repositoryRoot, clockifyRoot, restRoot);

  const extracted: AdapterEndpoint[] = [];
  for (const absolutePath of typescriptFiles(restRoot).sort()) {
    const sourceModule = relative(restRoot, absolutePath);
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
        const sourcePosition = source.getLineAndCharacterOfPosition(node.getStart(source));
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
          sourceModule,
          sourceLine: sourcePosition.line + 1,
          sourceColumn: sourcePosition.character + 1,
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
    compareText(
      `${left.sourceModule}\0${left.host}\0${left.method}\0${left.rawPath}`,
      `${right.sourceModule}\0${right.host}\0${right.method}\0${right.rawPath}`,
    )
    || left.sourceLine - right.sourceLine
    || left.sourceColumn - right.sourceColumn
    || compareText(left.pagination, right.pagination));
}

export function canonicalOpenApiPath(path: string): string {
  return path.replaceAll(/\{[^}]+\}/gu, "{}");
}

export function expandReviewedDynamicAdapterPath(path: string): readonly string[] {
  const expansions = [
    ["changeType", ["created", "deleted", "updated"]],
    ["kind", ["cost-rate", "hourly-rate"]],
  ] as const;
  let paths = [path];
  for (const [placeholder, values] of expansions) {
    const marker = `{${placeholder}}`;
    if (!paths.some((candidate) => candidate.includes(marker))) continue;
    paths = paths.flatMap((candidate) => values.map((value) => candidate.replaceAll(marker, value)));
  }
  return [...new Set(paths)].sort(compareText);
}

function openApiMethod(value: string): ApiMethod | undefined {
  switch (value) {
    case "get": return "GET";
    case "post": return "POST";
    case "put": return "PUT";
    case "patch": return "PATCH";
    case "delete": return "DELETE";
    default: return undefined;
  }
}

/** Parse only the OpenAPI path/method/operationId spine used by correlation. */
export function extractOpenApiDescriptionOperations(
  source: string,
): readonly OpenApiDescriptionOperation[] {
  const operations: OpenApiDescriptionOperation[] = [];
  let currentPath: string | undefined;
  let currentMethod: ApiMethod | undefined;
  for (const line of source.split(/\r?\n/u)) {
    const pathMatch = /^ {2}(\/[^:]+):\s*$/u.exec(line);
    if (pathMatch?.[1]) {
      currentPath = pathMatch[1].replace(/^\/v1/u, "");
      currentMethod = undefined;
      continue;
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete):\s*$/u.exec(line);
    if (methodMatch?.[1] && currentPath !== undefined) {
      currentMethod = openApiMethod(methodMatch[1]);
      continue;
    }
    const operationMatch = /^ {6}operationId:\s*(\S+)\s*$/u.exec(line);
    if (operationMatch?.[1] && currentPath !== undefined && currentMethod !== undefined) {
      operations.push({
        method: currentMethod,
        path: currentPath,
        operationId: operationMatch[1],
      });
    }
  }
  return operations.sort((left, right) => compareText(
    `${left.path}\0${left.method}\0${left.operationId}`,
    `${right.path}\0${right.method}\0${right.operationId}`,
  ));
}

export function correlateAdapterEndpointPaths(
  rawPath: string,
  normalizePlaceholderNames: (path: string) => string,
  expandDynamicLiterals: (path: string) => readonly string[],
): string[] {
  return [...new Set(expandDynamicLiterals(rawPath).map(normalizePlaceholderNames))]
    .sort(compareText);
}
