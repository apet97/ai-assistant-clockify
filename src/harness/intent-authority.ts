import type { WriteAuthorityMetadata } from "./action.js";
import { parseIntentLiteralValue } from "./intent-capability.js";
import type {
  IntentCapabilityV1,
  IntentLiteralConstraintV1,
  IntentLiteralValue,
} from "./intent-capability.js";
import { errorReceipt, type ErrorReceipt } from "./receipts.js";

export interface AuthorizeIntentWriteArgumentsInput {
  capability: IntentCapabilityV1;
  actionName: string;
  rawArgs: unknown;
  authority: WriteAuthorityMetadata;
  catalogHash: string;
  /** Verified session subject. Omission fails closed for reviewed `me` substitutions. */
  authenticatedAdminUserId?: string;
}

interface RawLeaf {
  concretePath: string;
  schemaPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return undefined;
  }
  if (Array.isArray(value)) {
    const children = value.map(stableJson);
    if (children.some((child) => child === undefined)) return undefined;
    return `[${children.join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().map((key) => {
      const child = stableJson(value[key]);
      return child === undefined ? undefined : `${JSON.stringify(key)}:${child}`;
    });
    if (entries.some((entry) => entry === undefined)) return undefined;
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function equalLiteral(actual: unknown, expected: IntentLiteralValue): boolean {
  try {
    const actualJson = stableJson(parseIntentLiteralValue(actual));
    return actualJson !== undefined && actualJson === stableJson(parseIntentLiteralValue(expected));
  } catch {
    return false;
  }
}

function rawLeaves(value: unknown, concretePath = "", schemaPath = ""): RawLeaf[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ concretePath: `${concretePath}[]`, schemaPath: `${schemaPath}[]` }];
    return value.flatMap((child, index) => rawLeaves(
      child,
      `${concretePath}[${index}]`,
      `${schemaPath}[]`,
    ));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return concretePath ? [{ concretePath, schemaPath }] : [];
    return entries.flatMap(([key, child]) => rawLeaves(
      child,
      concretePath ? `${concretePath}.${key}` : key,
      schemaPath ? `${schemaPath}.${key}` : key,
    ));
  }
  return [{ concretePath, schemaPath }];
}

type PathPart = { kind: "key"; value: string } | { kind: "index"; value?: number };

function parsePath(path: string): PathPart[] | undefined {
  if (!path || path.startsWith(".") || path.endsWith(".")) return undefined;
  const parts: PathPart[] = [];
  for (const segment of path.split(".")) {
    const bracketIndex = segment.indexOf("[");
    const key = bracketIndex === -1 ? segment : segment.slice(0, bracketIndex);
    if (!key || key.includes("]")) return undefined;
    parts.push({ kind: "key", value: key });
    let offset = key.length;
    while (offset < segment.length) {
      const token = /^\[(\d*)\]/.exec(segment.slice(offset));
      if (!token) return undefined;
      parts.push(token[1] === ""
        ? { kind: "index" }
        : { kind: "index", value: Number(token[1]) });
      offset += token[0].length;
    }
  }
  return parts;
}

function valuesAtPath(root: unknown, path: string): unknown[] | undefined {
  const parts = parsePath(path);
  if (!parts) return undefined;
  let current: unknown[] = [root];
  for (const part of parts) {
    const next: unknown[] = [];
    for (const value of current) {
      if (part.kind === "key") {
        if (!isRecord(value) || !Object.hasOwn(value, part.value)) continue;
        next.push(value[part.value]);
      } else if (Array.isArray(value)) {
        if (part.value === undefined) next.push(...value);
        else if (part.value < value.length) next.push(value[part.value]);
      }
    }
    current = next;
  }
  return current;
}

/** Distinguish an explicitly authored empty collection from an omitted field.
 * `valuesAtPath` intentionally flattens wildcard arrays, so both `{ tags: [] }`
 * and `{}` otherwise produce zero values for `tags[]`. Authority is exact about
 * presence too: a reviewed `[]` may clear a list, while omission means "leave it
 * unspecified" and must not satisfy that constraint. */
function pathIsPresent(root: unknown, path: string): boolean {
  const parts = parsePath(path);
  if (!parts) return false;
  const visit = (value: unknown, index: number): boolean => {
    if (index === parts.length) return true;
    const part = parts[index]!;
    if (part.kind === "key") {
      return isRecord(value) && Object.hasOwn(value, part.value) &&
        visit(value[part.value], index + 1);
    }
    if (!Array.isArray(value)) return false;
    if (part.value !== undefined) {
      return part.value < value.length && visit(value[part.value], index + 1);
    }
    // The wildcard itself is present on an explicit empty array when it is the
    // terminal path component. A deeper descendant must be present on every
    // traversed item: one explicit sibling must never mask an omitted value on
    // another sibling in the same constrained collection.
    return index === parts.length - 1 ||
      (value.length > 0 && value.every((child) => visit(child, index + 1)));
  };
  return visit(root, 0);
}

function normalizedPath(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

/** Shared path check for declaration-time and raw-argument authority. */
export function pathIsLiteralControlled(
  path: string,
  authority: Pick<WriteAuthorityMetadata, "literalControlledPaths">,
): boolean {
  const normalized = normalizedPath(path);
  return authority.literalControlledPaths.some((allowed) => {
    if (allowed.endsWith(".*")) {
      const openPath = allowed.slice(0, -2);
      return normalized === openPath || normalized.startsWith(`${openPath}.`);
    }
    // A constraint may bind a whole closed object/array exactly, so a known
    // descendant proves its parent is controlled. The inverse is intentionally
    // false unless the path carries the reviewed `.*` marker above.
    return allowed === normalized || allowed.startsWith(`${normalized}.`) || allowed.startsWith(`${normalized}[]`);
  });
}

function constraintMatchesRaw(
  constraint: IntentLiteralConstraintV1,
  rawArgs: unknown,
): boolean {
  const values = valuesAtPath(rawArgs, constraint.path);
  if (values === undefined || values.length === 0) {
    return pathIsPresent(rawArgs, constraint.path) &&
      Array.isArray(constraint.value) && constraint.value.length === 0;
  }
  if (constraint.path.includes("[]") && Array.isArray(constraint.value)) {
    return equalLiteral(values, constraint.value);
  }
  return values.length === 1 && equalLiteral(values[0], constraint.value);
}

/** The planner may canonicalize authored `me` to the verified session subject.
 * Keep this exception action/path scoped and exact: one `me` may become only
 * one occurrence of that same authenticated admin id. */
function matchesAuthenticatedMeSubstitution(
  input: AuthorizeIntentWriteArgumentsInput,
  constraint: IntentLiteralConstraintV1,
): boolean {
  const adminUserId = input.authenticatedAdminUserId;
  if (!adminUserId) return false;
  if (!input.authority.authenticatedSelfLiteralPaths.includes(constraint.path)) return false;
  const declared = constraint.value;
  const declaresOnlyMe = declared === "me" ||
    (Array.isArray(declared) && declared.length === 1 && declared[0] === "me");
  if (!declaresOnlyMe) return false;
  const actual = valuesAtPath(input.rawArgs, constraint.path);
  if (actual?.length !== 1) return false;
  if (actual[0] === adminUserId) return true;
  // `my` / `myself` are reviewed semantic aliases only for the project-member
  // rate's authenticated-self selector. They still resolve server-side to the
  // session subject; no arbitrary model-supplied id gains authority.
  return input.actionName === "clockify_projects_rate_update"
    && constraint.path === "userId"
    && (actual[0] === "my" || actual[0] === "myself");
}

function constraintCoversLeaf(constraintPath: string, leafPath: string): boolean {
  const constraint = parsePath(constraintPath);
  const leaf = parsePath(leafPath);
  if (!constraint || !leaf || constraint.length > leaf.length) return false;
  return constraint.every((part, index) => {
    const candidate = leaf[index];
    if (!candidate || candidate.kind !== part.kind) return false;
    if (part.kind === "key") return candidate.kind === "key" && candidate.value === part.value;
    return candidate.kind === "index" && (part.value === undefined || candidate.value === part.value);
  });
}

function cardinality(input: AuthorizeIntentWriteArgumentsInput): number | undefined {
  const path = input.authority.cardinality.argumentPath;
  if (input.authority.cardinality.mode !== "argument" || !path) return undefined;
  const values = valuesAtPath(input.rawArgs, path);
  return values?.length;
}

function denied(action: string, code: string, message: string): ErrorReceipt {
  return errorReceipt({
    action,
    code,
    message,
    recovery: {
      hint: "Ask the admin to issue a fresh request so the write can be previewed again.",
      retryable: false,
    },
  });
}

/**
 * Match the model's exact raw arguments against immutable admin-authored
 * authority. This runs before Zod preprocessing and before name/date/id
 * resolution: server-derived identifiers and permitted defaults may narrow the
 * eventual wire operation, but they never authorize an extra model literal.
 */
export function authorizeIntentWriteArguments(
  input: AuthorizeIntentWriteArgumentsInput,
): ErrorReceipt | undefined {
  if (input.capability.catalogHash !== input.catalogHash) {
    return denied(input.actionName, "intent_capability_catalog_drift",
      "The action catalog changed after this intent capability was declared.");
  }
  if (input.capability.mode === "deny_all_writes") {
    return denied(input.actionName, "intent_capability_denied",
      "This request has no valid write authority. Read actions remain available.");
  }
  const grant = input.capability.writeActions.find((candidate) => candidate.actionName === input.actionName);
  if (!grant) {
    return denied(input.actionName, "intent_capability_action_denied",
      "The admin-authored request did not authorize this write action.");
  }
  const count = cardinality(input);
  const maxArgumentItems = input.authority.cardinality.maxArgumentItems ??
    input.authority.cardinality.maxExecutions;
  if (count !== undefined && count > maxArgumentItems) {
    return denied(input.actionName, "intent_capability_cardinality_exceeded",
      "The raw argument batch exceeds this action's declared safety limit.");
  }

  for (const constraint of grant.literalConstraints) {
    if (!pathIsLiteralControlled(constraint.path, input.authority) ||
      (!constraintMatchesRaw(constraint, input.rawArgs) &&
       !matchesAuthenticatedMeSubstitution(input, constraint))) {
      return denied(input.actionName, "intent_capability_argument_mismatch",
        `Raw argument ${constraint.path} does not match the admin-authored literal.`);
    }
  }

  const leaves = rawLeaves(input.rawArgs);
  for (const leaf of leaves) {
    if (!pathIsLiteralControlled(leaf.schemaPath, input.authority) ||
      !grant.literalConstraints.some((constraint) => constraintCoversLeaf(constraint.path, leaf.concretePath))) {
      return denied(input.actionName, "intent_capability_argument_undeclared",
        `Raw argument ${leaf.concretePath || "<root>"} was not authorized by the admin-authored request.`);
    }
  }
  return undefined;
}
