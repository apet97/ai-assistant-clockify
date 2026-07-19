import { z } from "zod";
import type { ActionCatalogEntry } from "../harness/action.js";
import {
  buildAllowIntentCapabilityV1,
  buildDenyAllWritesIntentCapabilityV1,
  INTENT_LITERAL_CONSTRAINT_LIMIT,
  INTENT_LITERAL_MAX_DEPTH,
  INTENT_LITERAL_MAX_NODES,
  parseIntentLiteralValue,
  type IntentCapabilityV1,
  type IntentWriteActionDraftV1,
} from "../harness/intent-capability.js";
import type { ModelClient, ModelMessage, ToolDefinition } from "./model-client.js";

export const DECLARE_INTENT_TOOL_NAME = "declare_intent_capability";

const MAX_AUTHORED_TEXT_BYTES = 64 * 1024;
const MAX_DECLARED_WRITES = 64;

const sourceSpanSchema = z.object({
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().positive(),
  text: z.string().min(1),
}).strict();

const literalSchema = z.unknown().superRefine((value, ctx) => {
  try {
    parseIntentLiteralValue(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid_literal" });
  }
});

const constraintSchema = z.object({
  path: z.string().min(1),
  value: literalSchema,
  sourceSpan: sourceSpanSchema,
}).strict();

const declaredWriteSchema = z.object({
  actionName: z.string().min(1),
  sourceSpans: z.array(sourceSpanSchema).min(1).max(16),
  literalConstraints: z.array(constraintSchema).max(INTENT_LITERAL_CONSTRAINT_LIMIT),
  maxExecutions: z.literal(1),
}).strict();

const declarationSchema = z.object({
  writeActions: z.array(declaredWriteSchema).max(MAX_DECLARED_WRITES),
}).strict();

type SourceSpan = z.infer<typeof sourceSpanSchema>;
interface AuthoredSegment {
  source: "unresolved_prior" | "current";
  startByte: number;
  endByte: number;
  text: string;
}

interface DeclarationRequest {
  version: 1;
  offsetEncoding: "utf8-bytes";
  catalogHash: string;
  writeActionNames: string[];
  segments: AuthoredSegment[];
}

export interface DeclareIntentCapabilityInput {
  modelClient: ModelClient;
  /** Exact current admin-authored turn. Never assistant, tool, or host content. */
  currentText: string;
  /** Exact unresolved admin-authored context carried from a prior clarification. */
  unresolvedPriorText?: string;
  /** Exact names of model-visible write actions. Reads are never declared. */
  writeActionNames: readonly string[];
  /** Stable hash of the action/authority catalog the declaration is bound to. */
  catalogHash: string;
  /** Cooperative provider cancellation; never passed into action execution. */
  signal?: AbortSignal;
}

function literalJsonSchema(depth: number): Record<string, unknown> {
  const scalar = [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }];
  if (depth >= INTENT_LITERAL_MAX_DEPTH) return { anyOf: scalar };
  const child = literalJsonSchema(depth + 1);
  return {
    anyOf: [
      ...scalar,
      { type: "array", maxItems: INTENT_LITERAL_MAX_NODES - 1, items: child },
      { type: "object", maxProperties: INTENT_LITERAL_MAX_NODES - 1, additionalProperties: child },
    ],
  };
}

const declarationTool: ToolDefinition = {
  name: DECLARE_INTENT_TOOL_NAME,
  description: "Declare only write actions and literal constraints explicitly authored by the admin.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["writeActions"],
    properties: {
      writeActions: {
        type: "array",
        maxItems: MAX_DECLARED_WRITES,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["actionName", "sourceSpans", "literalConstraints", "maxExecutions"],
          properties: {
            actionName: { type: "string", minLength: 1 },
            sourceSpans: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["startByte", "endByte", "text"],
                properties: {
                  startByte: { type: "integer", minimum: 0 },
                  endByte: { type: "integer", minimum: 1 },
                  text: { type: "string", minLength: 1 },
                },
              },
            },
            literalConstraints: {
              type: "array",
              maxItems: INTENT_LITERAL_CONSTRAINT_LIMIT,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "value", "sourceSpan"],
                properties: {
                  path: { type: "string", minLength: 1 },
                  value: literalJsonSchema(1),
                  sourceSpan: {
                    type: "object",
                    additionalProperties: false,
                    required: ["startByte", "endByte", "text"],
                    properties: {
                      startByte: { type: "integer", minimum: 0 },
                      endByte: { type: "integer", minimum: 1 },
                      text: { type: "string", minLength: 1 },
                    },
                  },
                },
              },
            },
            maxExecutions: { type: "integer", const: 1 },
          },
        },
      },
    },
  },
};

const declarationSystemMessage: ModelMessage = {
  role: "system",
  content: [
    "You are a constrained intent declaration pass, not the main assistant.",
    "Declare only write actions explicitly requested in the authored segments.",
    "Every source span uses UTF-8 byte offsets in the canonical segment layout supplied by the server.",
    "Copy span text exactly. Literal constraints must cite the exact authored literal; do not infer IDs, dates, amounts, or values.",
    "Use only action names from writeActionNames. Set maxExecutions to 1. Return no prose.",
  ].join(" "),
};

/** Canonical persisted source: prior authored clarification context, LF, current turn. */
export function canonicalIntentAuthoredSource(
  input: Pick<DeclareIntentCapabilityInput, "currentText" | "unresolvedPriorText">,
): string {
  return input.unresolvedPriorText === undefined
    ? input.currentText
    : `${input.unresolvedPriorText}\n${input.currentText}`;
}

function buildRequest(input: DeclareIntentCapabilityInput): DeclarationRequest | undefined {
  const currentBytes = Buffer.byteLength(input.currentText, "utf8");
  const prior = input.unresolvedPriorText;
  const priorBytes = prior === undefined ? 0 : Buffer.byteLength(prior, "utf8");
  if (currentBytes + priorBytes > MAX_AUTHORED_TEXT_BYTES) return undefined;

  const writeActionNames = [...input.writeActionNames];
  if (new Set(writeActionNames).size !== writeActionNames.length ||
    writeActionNames.some((name) => name.length === 0)) return undefined;

  const segments: AuthoredSegment[] = [];
  let nextStartByte = 0;
  if (prior !== undefined) {
    segments.push({ source: "unresolved_prior", startByte: 0, endByte: priorBytes, text: prior });
    nextStartByte = priorBytes + 1; // one canonical LF byte separates authored segments
  }
  segments.push({
    source: "current",
    startByte: nextStartByte,
    endByte: nextStartByte + currentBytes,
    text: input.currentText,
  });
  return {
    version: 1,
    offsetEncoding: "utf8-bytes",
    catalogHash: input.catalogHash,
    writeActionNames,
    segments,
  };
}

function denyCapability(input: DeclareIntentCapabilityInput, reason: string): IntentCapabilityV1 {
  return buildDenyAllWritesIntentCapabilityV1({
    authoredSource: canonicalIntentAuthoredSource(input),
    catalogHash: input.catalogHash,
    reason,
  });
}

function sourceTextForSpan(span: SourceSpan, segments: AuthoredSegment[]): string | undefined {
  if (span.endByte <= span.startByte) return undefined;
  const segment = segments.find((item) =>
    span.startByte >= item.startByte && span.endByte <= item.endByte);
  if (!segment) return undefined;

  const bytes = Buffer.from(segment.text, "utf8");
  const localStart = span.startByte - segment.startByte;
  const localEnd = span.endByte - segment.startByte;
  if (localStart < 0 || localEnd > bytes.length) return undefined;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(localStart, localEnd));
    return decoded === span.text ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function unquote(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  return first === last && (first === '"' || first === "'" || first === "`")
    ? text.slice(1, -1)
    : text;
}

function normalizeString(text: string): string {
  return unquote(text.trim()).normalize("NFC");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedLiteral(spanText: string, declared: unknown): ReturnType<typeof parseIntentLiteralValue> | undefined {
  if (Array.isArray(declared) || (declared !== null && typeof declared === "object")) {
    try {
      const source = parseIntentLiteralValue(JSON.parse(spanText.trim()) as unknown);
      const expected = parseIntentLiteralValue(declared);
      return stableJson(source) === stableJson(expected) ? expected : undefined;
    } catch {
      return undefined;
    }
  }
  const normalizedSource = normalizeString(spanText);
  if (typeof declared === "string") {
    const normalizedDeclared = normalizeString(declared);
    return normalizedSource === normalizedDeclared ? parseIntentLiteralValue(normalizedDeclared) : undefined;
  }
  if (typeof declared === "number") {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalizedSource)) return undefined;
    const parsed = Number(normalizedSource);
    return Number.isFinite(parsed) && Object.is(parsed, declared) ? parseIntentLiteralValue(declared) : undefined;
  }
  if (typeof declared === "boolean") {
    return normalizedSource === String(declared) ? parseIntentLiteralValue(declared) : undefined;
  }
  return normalizedSource === "null" ? null : undefined;
}

function validateDeclaration(
  raw: unknown,
  request: DeclarationRequest,
): IntentWriteActionDraftV1[] | undefined {
  const parsed = declarationSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  const allowedNames = new Set(request.writeActionNames);
  const seenActions = new Set<string>();
  const validatedWrites: IntentWriteActionDraftV1[] = [];
  for (const write of parsed.data.writeActions) {
    if (!allowedNames.has(write.actionName) || seenActions.has(write.actionName)) return undefined;
    seenActions.add(write.actionName);
    if (write.sourceSpans.some((span) => sourceTextForSpan(span, request.segments) === undefined)) {
      return undefined;
    }

    const literalConstraints = [];
    const constraintPaths = new Set<string>();
    for (const constraint of write.literalConstraints) {
      if (constraintPaths.has(constraint.path)) return undefined;
      constraintPaths.add(constraint.path);
      const sourceText = sourceTextForSpan(constraint.sourceSpan, request.segments);
      if (sourceText === undefined) return undefined;
      const value = normalizedLiteral(sourceText, constraint.value);
      if (value === undefined) return undefined;
      literalConstraints.push({ ...constraint, value });
    }
    validatedWrites.push({ ...write, literalConstraints });
  }
  return validatedWrites;
}

function parseJsonDeclaration(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Run the isolated declaration pass exactly once. Any provider/schema/grounding
 * failure returns a capability that denies writes; reads remain available when
 * the caller applies {@link filterCatalogByIntentCapability}.
 */
export async function declareIntentCapability(
  input: DeclareIntentCapabilityInput,
): Promise<IntentCapabilityV1> {
  const request = buildRequest(input);
  const denied = denyCapability(input, "declaration_invalid");
  if (!request) return denied;
  const messages: ModelMessage[] = [
    declarationSystemMessage,
    { role: "user", content: JSON.stringify(request) },
  ];

  let raw: unknown;
  try {
    if (typeof input.modelClient.completeWithTools === "function") {
      const completion = await input.modelClient.completeWithTools(
        messages,
        [declarationTool],
        input.signal,
      );
      if (completion.toolCalls.length !== 1 ||
        completion.toolCalls[0]?.name !== DECLARE_INTENT_TOOL_NAME) return denied;
      raw = completion.toolCalls[0].arguments;
    } else {
      const completion = await input.modelClient.complete(messages, undefined, input.signal);
      raw = parseJsonDeclaration(completion);
    }
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    return denyCapability(input, "provider_unavailable");
  }

  const writeActions = validateDeclaration(raw, request);
  if (!writeActions || writeActions.length === 0) return denied;
  try {
    return buildAllowIntentCapabilityV1({
      authoredSource: canonicalIntentAuthoredSource(input),
      catalogHash: input.catalogHash,
      writeActions,
    });
  } catch {
    return denied;
  }
}

/** Keep all reads, plus only the exact write actions authorized by capability. */
export function filterCatalogByIntentCapability(
  catalog: readonly ActionCatalogEntry[],
  capability: IntentCapabilityV1,
): ActionCatalogEntry[] {
  const allowedWrites = capability.mode === "allow"
    ? new Set(capability.writeActions.map((action) => action.actionName))
    : new Set<string>();
  return catalog.filter((action) => {
    const isRead = action.risks.length > 0 && action.risks.every((risk) => risk === "read");
    return isRead || allowedWrites.has(action.name);
  });
}
