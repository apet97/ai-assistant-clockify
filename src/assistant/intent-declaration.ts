import { z } from "zod";
import type {
  ActionCatalogEntry,
  AuthoredIntentMetadata,
  SemanticLiteralAlias,
} from "../harness/action.js";
import { getAction } from "../harness/catalog.js";
import { pathIsLiteralControlled } from "../harness/intent-authority.js";
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
import { normalizeSemanticLiteralAliasPhrase } from "../harness/write-authority.js";
import type { ModelClient, ModelMessage, ToolDefinition } from "./model-client.js";

export const DECLARE_INTENT_TOOL_NAME = "declare_intent_capability";

export type IntentDeclarationProvenance =
  | "provider_tool"
  | "provider_json"
  | "local_empty_zero_tool"
  | "invalid";

const MAX_AUTHORED_TEXT_BYTES = 64 * 1024;
const MAX_DECLARED_WRITES = 64;
const MAX_SOURCE_QUOTE_OCCURRENCE = 1023;
// Largest known downstream decimal scale for a raw numeric write: an invoice
// major-unit amount is converted to minor units (x100), then its unit price is
// encoded for Clockify's wire contract (x100). Keep every repaired literal safe
// through both integer transformations, whether the provider emitted a quoted
// numeric token or a native JSON number.
const MAX_CANONICAL_NUMERIC_ABS = Math.floor(Number.MAX_SAFE_INTEGER / 10_000);

const sourceSpanSchema = z.object({
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().positive(),
  text: z.string().min(1),
}).strict();

const sourceQuoteSchema = z.object({
  segment: z.enum(["unresolved_prior", "current"]),
  quote: z.string().min(1).max(MAX_AUTHORED_TEXT_BYTES),
  // Optional only for compatibility with deterministic scripted clients. The
  // provider-facing tool requires an explicit zero-based occurrence.
  occurrence: z.number().int().min(0).max(MAX_SOURCE_QUOTE_OCCURRENCE).optional(),
}).strict();

const literalSchema = z.unknown().superRefine((value, ctx) => {
  try {
    parseIntentLiteralValue(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid_literal" });
  }
});

const legacyConstraintSchema = z.object({
  path: z.string().min(1),
  value: literalSchema,
  sourceSpan: sourceSpanSchema,
}).strict();

const quotedConstraintSchema = z.object({
  path: z.string().min(1),
  value: literalSchema,
  sourceRef: sourceQuoteSchema,
}).strict();

const legacyDeclaredWriteSchema = z.object({
  actionName: z.string().min(1),
  sourceSpans: z.array(sourceSpanSchema).min(1).max(16),
  literalConstraints: z.array(legacyConstraintSchema).max(INTENT_LITERAL_CONSTRAINT_LIMIT),
  maxExecutions: z.literal(1),
}).strict();

const quotedDeclaredWriteSchema = z.object({
  actionName: z.string().min(1),
  sourceRefs: z.array(sourceQuoteSchema).min(1).max(16),
  literalConstraints: z.array(quotedConstraintSchema).max(INTENT_LITERAL_CONSTRAINT_LIMIT),
  maxExecutions: z.literal(1),
}).strict();

// Persisted capabilities continue to use byte spans. The legacy branch is
// accepted only for compatibility with deterministic scripted clients; the
// provider-facing tool below exposes quote references so the server, rather
// than a weak model, computes UTF-8 offsets.
const declaredWriteSchema = z.union([quotedDeclaredWriteSchema, legacyDeclaredWriteSchema]);

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
  /** Trusted, catalog-derived declaration surface. This precedes authored text
   * in the stable request JSON so DeepSeek can cache the unchanged prefix. */
  writeActionContracts?: Array<{
    actionName: string;
    literalControlledPaths: readonly string[];
    numericLiteralPaths: readonly string[];
    semanticLiteralAliases: readonly SemanticLiteralAlias[];
    authoredIntent?: AuthoredIntentMetadata;
  }>;
  /** Deterministic recall hint only. Validation still accepts solely the full
   * trusted writeActionNames allowlist and exact authored evidence. */
  candidateWriteActionNames?: string[];
  requireCurrentActionSpan?: true;
  segments: AuthoredSegment[];
}

export interface DeclareIntentCapabilityInput {
  modelClient: ModelClient;
  /** Exact current admin-authored turn. Never assistant, tool, or host content. */
  currentText: string;
  /** Exact unresolved admin-authored context carried from a prior clarification. */
  unresolvedPriorText?: string;
  /** Carried text may bind literals but cannot itself authorize the action. */
  requireCurrentActionSpan?: boolean;
  /** Exact names of model-visible write actions. Reads are never declared. */
  writeActionNames: readonly string[];
  /** Small deterministic candidate subset; never an authority boundary. */
  candidateWriteActionNames?: readonly string[];
  /** Stable hash of the action/authority catalog the declaration is bound to. */
  catalogHash: string;
  /** Cooperative provider cancellation; never passed into action execution. */
  signal?: AbortSignal;
  /** Secret-free evidence of how the declaration DTO was obtained. */
  onProvenance?: (provenance: IntentDeclarationProvenance) => void;
}

function reportProvenance(
  input: DeclareIntentCapabilityInput,
  provenance: IntentDeclarationProvenance,
): void {
  try {
    input.onProvenance?.(provenance);
  } catch {
    // Evidence hooks must never change the safety outcome.
  }
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

function declarationTool(writeActionNames: readonly string[]): ToolDefinition {
  return {
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
          required: ["actionName", "sourceRefs", "literalConstraints", "maxExecutions"],
          properties: {
            actionName: { type: "string", enum: [...writeActionNames] },
            sourceRefs: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["segment", "quote", "occurrence"],
                properties: {
                  segment: { type: "string", enum: ["unresolved_prior", "current"] },
                  quote: { type: "string", minLength: 1, maxLength: MAX_AUTHORED_TEXT_BYTES },
                  occurrence: { type: "integer", minimum: 0, maximum: MAX_SOURCE_QUOTE_OCCURRENCE },
                },
              },
            },
            literalConstraints: {
              type: "array",
              maxItems: INTENT_LITERAL_CONSTRAINT_LIMIT,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "value", "sourceRef"],
                properties: {
                  path: { type: "string", minLength: 1 },
                  value: literalJsonSchema(1),
                  sourceRef: {
                    type: "object",
                    additionalProperties: false,
                    required: ["segment", "quote", "occurrence"],
                    properties: {
                      segment: { type: "string", enum: ["unresolved_prior", "current"] },
                      quote: {
                        type: "string",
                        minLength: 1,
                        maxLength: MAX_AUTHORED_TEXT_BYTES,
                        description: "Copy the shortest exact authored substring that encodes this literal value; quote the value itself, not the whole command.",
                      },
                      occurrence: { type: "integer", minimum: 0, maximum: MAX_SOURCE_QUOTE_OCCURRENCE },
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
}

const declarationSystemMessage: ModelMessage = {
  role: "system",
  content: [
    "You are a constrained intent declaration pass, not the main assistant.",
    "Declare only write actions explicitly requested in the authored segments.",
    "For every sourceRefs/sourceRef item, copy an exact unmodified quote, its segment name, and its zero-based occurrence in that segment; never calculate byte offsets.",
    "Literal constraints must cite the exact authored literal and occurrence; do not infer IDs, dates, amounts, or values.",
    "A literal constraint sourceRef.quote must be the shortest exact authored substring that encodes its value (for value qwen quote qwen, not the whole sentence).",
    "Use only paths in the exact action's writeActionContracts entry. A semantic scalar mapping is valid only when that same action/path/value lists the exact authored phrase.",
    "For paths listed in numericLiteralPaths, emit a JSON number rather than a quoted numeric string.",
    "Check candidateWriteActionNames first as a recall hint, but declare an action only when the authored segments explicitly request it; the full writeActionNames list remains the only name allowlist.",
    "When requireCurrentActionSpan is true, every declared write must include an exact current sourceRef that expresses that action; unresolved_prior may bind literal constraints only and cannot supply the action command.",
    "When an action contract includes authoredIntent, sourceRefs must overlap its authored command and every matching literal cue must bind the listed path. authoredIntent is present only for extra safe-write grounding; for a contract without authoredIntent, its absence is not a denial—declare it when the authored segment explicitly commands that action and bind every exact authored literal path.",
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
  const allowedNames = new Set(writeActionNames);
  const candidateWriteActionNames = [...(input.candidateWriteActionNames ?? writeActionNames)]
    .filter((name, index, values) => allowedNames.has(name) && values.indexOf(name) === index);

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
  const writeActionContracts = writeActionNames.flatMap((actionName) => {
    const authority = getAction(actionName)?.writeAuthority;
    return authority ? [{
      actionName,
      literalControlledPaths: authority.literalControlledPaths,
      numericLiteralPaths: authority.numericLiteralPaths,
      semanticLiteralAliases: authority.semanticLiteralAliases,
      ...(authority.authoredIntent ? { authoredIntent: authority.authoredIntent } : {}),
    }] : [];
  });
  if (writeActionContracts.length !== writeActionNames.length) return undefined;
  return {
    version: 1,
    offsetEncoding: "utf8-bytes",
    catalogHash: input.catalogHash,
    writeActionNames,
    writeActionContracts,
    candidateWriteActionNames,
    ...(input.requireCurrentActionSpan ? { requireCurrentActionSpan: true as const } : {}),
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

function segmentForSpan(span: SourceSpan, segments: AuthoredSegment[]): AuthoredSegment | undefined {
  if (span.endByte <= span.startByte) return undefined;
  return segments.find((item) =>
    span.startByte >= item.startByte && span.endByte <= item.endByte);
}

function sourceTextForSpan(span: SourceSpan, segments: AuthoredSegment[]): string | undefined {
  const segment = segmentForSpan(span, segments);
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

type SourceQuote = z.infer<typeof sourceQuoteSchema>;

/** Resolve an exact quote occurrence without asking the model for byte offsets.
 * Legacy scripted clients may omit occurrence only when the quote is unique. */
function sourceSpanForQuote(ref: SourceQuote, segments: AuthoredSegment[]): SourceSpan | undefined {
  const segment = segments.find((item) => item.source === ref.segment);
  if (!segment) return undefined;
  let characterStart = segment.text.indexOf(ref.quote);
  if (characterStart < 0) return undefined;
  if (ref.occurrence === undefined) {
    if (segment.text.indexOf(ref.quote, characterStart + 1) >= 0) return undefined;
  } else {
    let searchFrom = characterStart + ref.quote.length;
    for (let occurrence = 0; occurrence < ref.occurrence; occurrence += 1) {
      characterStart = segment.text.indexOf(ref.quote, searchFrom);
      if (characterStart < 0) return undefined;
      searchFrom = characterStart + ref.quote.length;
    }
  }
  const startByte = segment.startByte + Buffer.byteLength(segment.text.slice(0, characterStart), "utf8");
  return {
    startByte,
    endByte: startByte + Buffer.byteLength(ref.quote, "utf8"),
    text: ref.quote,
  };
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

function sameScalar(left: unknown, right: SemanticLiteralAlias["value"]): boolean {
  return left === right;
}

function semanticPhrasePattern(phrase: string): RegExp | undefined {
  const tokens = phrase
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens.length === 0) return undefined;
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped[0] === "not") escaped[0] = "(?:not|non)";
  return new RegExp(escaped.join("[\\p{P}\\p{S}\\s]+"), "giu");
}

/** A shorter positive spelling must not invert a reviewed longer negative (or
 * vice versa). Example: the `billable` span inside authored `non-billable`
 * cannot authorize true when that exact longer phrase is reviewed as false. */
function semanticAliasShadowedByOpposite(
  sourceSpan: SourceSpan,
  declared: unknown,
  aliases: readonly SemanticLiteralAlias[],
  segments: AuthoredSegment[],
): boolean {
  const segment = segmentForSpan(sourceSpan, segments);
  if (!segment) return true;
  if (declared === true) {
    const localStart = sourceSpan.startByte - segment.startByte;
    const prefix = Buffer.from(segment.text, "utf8").subarray(0, localStart).toString("utf8");
    const nearby = Array.from(prefix).slice(-64).join("");
    if (/(?:\bdo\s+not|\bdon't|\bnever|\bisn't|\bis\s+not|\bwasn't|\bwas\s+not|\bshouldn't|\bshould\s+not|\bcannot|\bcan't)\s+(?:[\p{L}\p{M}]+\s+){0,4}$/iu.test(nearby)) {
      return true;
    }
  }
  for (const alias of aliases) {
    if (sameScalar(declared, alias.value)) continue;
    for (const phrase of alias.authoredPhrases) {
      const pattern = semanticPhrasePattern(phrase);
      if (!pattern) return true;
      for (const match of segment.text.matchAll(pattern)) {
        const characterStart = match.index;
        const startByte = segment.startByte + Buffer.byteLength(segment.text.slice(0, characterStart), "utf8");
        const endByte = startByte + Buffer.byteLength(match[0], "utf8");
        if (startByte <= sourceSpan.startByte && endByte >= sourceSpan.endByte) return true;
      }
    }
  }
  return false;
}

/** Semantic aliases must occupy a complete authored token or phrase. Without
 * this source-context check a provider can cite the reviewed `billable` alias
 * from inside an unrelated word such as `unbillable` or `rebillable`. Unicode
 * letters, marks, numbers, and connector punctuation all continue a word;
 * whitespace and punctuation such as the reviewed `non-public` hyphen do not. */
function semanticAliasHasWholeTokenBoundaries(
  sourceSpan: SourceSpan,
  segments: AuthoredSegment[],
): boolean {
  const segment = segmentForSpan(sourceSpan, segments);
  if (!segment) return false;
  const bytes = Buffer.from(segment.text, "utf8");
  const relativeStart = sourceSpan.startByte - segment.startByte;
  const relativeEnd = sourceSpan.endByte - segment.startByte;
  if (relativeStart < 0 || relativeEnd > bytes.length || relativeStart >= relativeEnd) return false;
  const before = bytes.subarray(0, relativeStart).toString("utf8");
  const after = bytes.subarray(relativeEnd).toString("utf8");
  const previous = Array.from(before).at(-1);
  const next = Array.from(after)[0];
  const continuesWord = (character: string | undefined): boolean =>
    character !== undefined && /[\p{L}\p{M}\p{N}\p{Pc}]/u.test(character);
  return !continuesWord(previous) && !continuesWord(next);
}

function normalizedLiteral(
  spanText: string,
  declared: unknown,
  aliases: readonly SemanticLiteralAlias[] = [],
  sourceSpan?: SourceSpan,
  segments?: AuthoredSegment[],
  requiresNumeric = false,
): ReturnType<typeof parseIntentLiteralValue> | undefined {
  if (requiresNumeric && typeof declared !== "string" && typeof declared !== "number") return undefined;
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
    if (requiresNumeric) {
      if (declared !== spanText ||
        !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(spanText)) return undefined;
      const parsed = Number(spanText);
      if (!Number.isFinite(parsed) || Object.is(parsed, -0) || Math.abs(parsed) > MAX_CANONICAL_NUMERIC_ABS ||
        (!spanText.includes(".") && !Number.isSafeInteger(parsed))) {
        return undefined;
      }
      const [integer, fraction] = spanText.split(".");
      const normalizedToken = fraction === undefined
        ? integer!
        : `${integer!}.${fraction.replace(/0+$/u, "")}`.replace(/\.$/u, "");
      if (String(parsed) !== normalizedToken) return undefined;
      return parseIntentLiteralValue(parsed);
    }
    const normalizedDeclared = normalizeString(declared);
    return normalizedSource === normalizedDeclared ? parseIntentLiteralValue(normalizedDeclared) : undefined;
  }
  if (typeof declared === "number") {
    if (requiresNumeric && (Object.is(declared, -0) || Math.abs(declared) > MAX_CANONICAL_NUMERIC_ABS)) {
      return undefined;
    }
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalizedSource)) return undefined;
    const parsed = Number(normalizedSource);
    return Number.isFinite(parsed) && Object.is(parsed, declared) ? parseIntentLiteralValue(declared) : undefined;
  }
  if (typeof declared === "boolean") {
    if (normalizedSource === String(declared)) return parseIntentLiteralValue(declared);
  } else if (declared === null && normalizedSource === "null") {
    return null;
  }
  const semanticSource = normalizeSemanticLiteralAliasPhrase(spanText);
  const matched = aliases.some((alias) => sameScalar(declared, alias.value) &&
    alias.authoredPhrases.includes(semanticSource));
  return matched && sourceSpan && segments &&
    semanticAliasHasWholeTokenBoundaries(sourceSpan, segments) &&
    !semanticAliasShadowedByOpposite(sourceSpan, declared, aliases, segments)
    ? parseIntentLiteralValue(declared)
    : undefined;
}

interface AuthoredWindow {
  source: AuthoredSegment["source"];
  startByte: number;
  endByte: number;
  text: string;
}

const MAX_AUTHORED_COMMAND_CLAUSE_BYTES = 512;

function authoredClauses(segment: AuthoredSegment): AuthoredWindow[] {
  const clauses: AuthoredWindow[] = [];
  for (const match of segment.text.matchAll(/[^.!?;\n]+(?:[.!?;]|$)/gu)) {
    const raw = match[0];
    const leading = raw.search(/\S/u);
    if (leading < 0) continue;
    const trailing = raw.match(/\s*$/u)?.[0].length ?? 0;
    const text = raw.slice(leading, raw.length - trailing);
    if (Buffer.byteLength(text, "utf8") > MAX_AUTHORED_COMMAND_CLAUSE_BYTES) continue;
    const characterStart = match.index + leading;
    const startByte = segment.startByte + Buffer.byteLength(
      segment.text.slice(0, characterStart),
      "utf8",
    );
    clauses.push({
      source: segment.source,
      startByte,
      endByte: startByte + Buffer.byteLength(text, "utf8"),
      text,
    });
  }
  return clauses;
}

function isProhibitedCommandClause(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  return [
    /^(?:please[\s,:;-]+)?(?:do\s+not|don't|never)\b/iu,
    /^(?:can|could|would|will)\s+you\s+not\b/iu,
    /^i\s+(?:do\s+not|don't)\s+(?:want|need|would\s+like)\b/iu,
  ].some((pattern) => pattern.test(normalized));
}

function commandFormPatterns(actionPattern: string): RegExp[] {
  const polite = "(?:please[\\s,:;-]+)?";
  const base = `(?:${actionPattern})`;
  return [
    new RegExp(`^\\s*${polite}${base}`, "iu"),
    new RegExp(`^\\s*(?:can|could|would|will)\\s+you\\s+${polite}${base}`, "iu"),
    new RegExp(`^\\s*(?:i\\s+)?(?:want|need|would\\s+like)\\s+(?:you\\s+)?to\\s+${base}`, "iu"),
    new RegExp(`^\\s*i(?:['’]d|\\s+would)\\s+like\\s+(?:you\\s+)?to\\s+${base}`, "iu"),
    new RegExp(`(?:^|\\b(?:and|then)[\\s,:;-]+)${polite}${base}`, "iu"),
  ];
}

function gerundCommandFormPattern(actionPattern: string): RegExp {
  const polite = "(?:please[\\s,:;-]+)?";
  return new RegExp(
    `^\\s*would\\s+you\\s+mind\\s+${polite}(?:${actionPattern})`,
    "iu",
  );
}

function currentTurnCancelsPriorWrite(segments: readonly AuthoredSegment[]): boolean {
  if (!segments.some((segment) => segment.source === "unresolved_prior")) return false;
  const current = segments.find((segment) => segment.source === "current")?.text
    .normalize("NFKC").trim();
  if (!current) return false;
  return /^(?:(?:actually|no|no\s+thanks|wait)[\s,:;-]+)?(?:please[\s,:;-]+)?(?:cancel(?:\s+(?:that|it|the\s+request))?|never\s*mind|forget\s+(?:that|it)|do\s+not\s+do\s+that|don't\s+do\s+that)[.!?\s]*$/iu.test(current);
}

/** Byte offsets for an authored cancellation/standalone negation introduced by
 * an utterance delimiter. Requiring punctuation before `No` distinguishes
 * `Create project Atlas? No.` from the literal name `Create project No.`. */
function currentTurnCancellationStarts(segments: readonly AuthoredSegment[]): number[] {
  const current = segments.find((segment) => segment.source === "current");
  if (!current) return [];
  const pattern = /(?:^|[.!?;,]\s*)(?<cancellation>(?:(?:actually|wait)\s*[,;:]?\s*)?(?:please\s*[,;:]?\s*)?(?:no(?:\s+thanks)?|never\s*mind|cancel(?:\s+(?:that|it|the\s+request))?|forget\s+(?:that|it)|do\s+not\s+do\s+that|don't\s+do\s+that))(?=[.!?;\s]*(?:$|[.!?;]))/dgiu;
  const starts: number[] = [];
  for (const rawMatch of current.text.matchAll(pattern)) {
    const match = rawMatch as RegExpMatchArray & {
      indices?: { groups?: Record<string, [number, number] | undefined> };
    };
    const cancellation = match.indices?.groups?.cancellation;
    if (!cancellation) continue;
    starts.push(current.startByte + Buffer.byteLength(current.text.slice(0, cancellation[0]), "utf8"));
  }
  return starts;
}

function commandWindows(
  metadata: AuthoredIntentMetadata,
  segments: readonly AuthoredSegment[],
): AuthoredWindow[] {
  if (currentTurnCancelsPriorWrite(segments)) return [];
  const cancellationStarts = currentTurnCancellationStarts(segments);
  const matches: AuthoredWindow[] = [];
  for (const clause of segments.flatMap(authoredClauses)) {
    if (isProhibitedCommandClause(clause.text) || metadata.forbiddenPatterns.some((source) =>
      new RegExp(source, "iu").test(clause.text))) continue;
    const baseCommand = metadata.commandPatterns.some((source) =>
      commandFormPatterns(source).some((pattern) => pattern.test(clause.text)));
    const gerundCommand = metadata.commandGerundPatterns.some((source) =>
      gerundCommandFormPattern(source).test(clause.text));
    if (!baseCommand && !gerundCommand) continue;
    // A later cancellation revokes only commands before it. This ordering lets
    // a fresh command after "never mind" stand on its own while preventing a
    // provider from citing the revoked earlier command as write authority.
    if (clause.source === "current" && cancellationStarts.some((start) => start > clause.startByte)) continue;
    matches.push(clause);
  }
  return matches;
}

function spansOverlap(left: Pick<SourceSpan, "startByte" | "endByte">, right: AuthoredWindow): boolean {
  return left.startByte < right.endByte && right.startByte < left.endByte;
}

function cueOccursOutsideOtherLiteral(
  patternSource: string,
  windows: readonly AuthoredWindow[],
): boolean {
  for (const window of windows) {
    const pattern = new RegExp(patternSource, "giu");
    for (const match of window.text.matchAll(pattern)) {
      if (!match[0]) continue;
      return true;
    }
  }
  return false;
}

function normalizedConstraintPath(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

function hasConstraintForPath(
  constraints: readonly IntentWriteActionDraftV1["literalConstraints"][number][],
  path: string,
): boolean {
  return constraints.some((constraint) => normalizedConstraintPath(constraint.path) === path);
}

interface ByteRange { startByte: number; endByte: number }

function roleValueRanges(
  patternSource: string,
  windows: readonly AuthoredWindow[],
): ByteRange[] {
  const ranges: ByteRange[] = [];
  for (const window of windows) {
    const pattern = new RegExp(patternSource, "dgiu");
    for (const rawMatch of window.text.matchAll(pattern)) {
      const match = rawMatch as RegExpMatchArray & {
        indices?: { groups?: Record<string, [number, number] | undefined> };
      };
      const indices = match.indices?.groups?.value;
      if (!indices) continue;
      const startByte = window.startByte + Buffer.byteLength(
        window.text.slice(0, indices[0]),
        "utf8",
      );
      ranges.push({
        startByte,
        endByte: startByte + Buffer.byteLength(
          window.text.slice(indices[0], indices[1]),
          "utf8",
        ),
      });
    }
  }
  return ranges;
}

function constraintIsBoundToRole(
  constraint: IntentWriteActionDraftV1["literalConstraints"][number],
  ranges: readonly ByteRange[],
): boolean {
  return ranges.some((range) =>
    constraint.sourceSpan.startByte >= range.startByte &&
    constraint.sourceSpan.endByte <= range.endByte);
}

function satisfiesAuthoredIntent(
  actionName: string,
  metadata: AuthoredIntentMetadata | undefined,
  actionSpans: readonly SourceSpan[],
  constraints: readonly IntentWriteActionDraftV1["literalConstraints"][number][],
  semanticLiteralAliases: readonly SemanticLiteralAlias[],
  segments: readonly AuthoredSegment[],
  requireCurrentActionSpan = false,
): boolean {
  if (!metadata) return !requireCurrentActionSpan;
  const commands = commandWindows(metadata, segments);
  const current = segments.find((segment) => segment.source === "current");
  const currentCommands = commands.filter((command) => command.source === "current");
  const currentCommand = currentCommands.some((command) =>
    actionSpans.some((span) => spansOverlap(span, command)));
  const explicitContinuation = requireCurrentActionSpan && actionName === "clockify_projects_create" && current !== undefined &&
    /^(?:create|make)\s+(?:it|that)[.!?\s]*$/iu.test(current.text) &&
    commands.some((command) => command.source === "unresolved_prior") &&
    actionSpans.some((span) => span.startByte < current.endByte && current.startByte < span.endByte);
  if (commands.length === 0) return false;
  if (requireCurrentActionSpan) {
    if (!currentCommand && !explicitContinuation) return false;
  } else if (!actionSpans.some((span) => commands.some((command) => spansOverlap(span, command)))) {
    return false;
  }

  // A terse current clarification may supply a literal for a command retained
  // in unresolved_prior. Otherwise cues are scoped to the matched command
  // clauses so an unrelated sentence cannot add authority requirements.
  if (current && commands.every((command) => command.source !== "current") &&
    Buffer.byteLength(current.text, "utf8") > MAX_AUTHORED_COMMAND_CLAUSE_BYTES) return false;
  const windows = commands.some((command) => command.source === "current") || !current
    ? commands
    : [...commands, current];
  const priorOnlyCommand = commands.every((command) => command.source === "unresolved_prior");
  const priorCuedRoleObligations = priorOnlyCommand
    ? metadata.literalObligations.filter((obligation) =>
      obligation.sourceRolePatterns !== undefined && obligation.cuePatterns.some((pattern) =>
        cueOccursOutsideOtherLiteral(pattern, commands)))
    : [];

  for (const obligation of metadata.literalObligations) {
    const cuePresent = obligation.cuePatterns.some((pattern) =>
      cueOccursOutsideOtherLiteral(pattern, windows));
    if (cuePresent && !obligation.anyOfPaths.some((path) =>
      hasConstraintForPath(constraints, path))) return false;
    if (obligation.sourceRolePatterns) {
      const ranges = obligation.sourceRolePatterns.flatMap((pattern) =>
        roleValueRanges(pattern, windows));
      const roleConstraints = constraints.filter((constraint) =>
        obligation.anyOfPaths.includes(normalizedConstraintPath(constraint.path)));
      const terseClarification = current && priorCuedRoleObligations.length === 1 &&
        priorCuedRoleObligations[0] === obligation && roleConstraints.length === 1 &&
        constraints.length === 1 && (() => {
          const constraint = roleConstraints[0]!;
          const segment = segmentForSpan(constraint.sourceSpan, [...segments]);
          if (segment?.source !== "current") return false;
          const currentLiteral = current.text.trim().replace(/[.!?]+$/u, "").trim();
          return normalizeString(currentLiteral) === normalizeString(constraint.sourceSpan.text) &&
            Buffer.byteLength(currentLiteral, "utf8") <= 160;
        })();
      if (!terseClarification && roleConstraints.some((constraint) =>
        !constraintIsBoundToRole(constraint, ranges))) return false;
      if (cuePresent && !roleConstraints.some((constraint) =>
        constraintIsBoundToRole(constraint, ranges)) && !terseClarification) return false;
    }
  }

  const aliasesByPath = new Map<string, SemanticLiteralAlias[]>();
  for (const alias of semanticLiteralAliases) {
    const aliases = aliasesByPath.get(alias.path) ?? [];
    aliases.push(alias);
    aliasesByPath.set(alias.path, aliases);
  }
  for (const [path, aliases] of aliasesByPath) {
    const cuePresent = aliases.some((alias) => alias.authoredPhrases.some((phrase) => {
      const pattern = semanticPhrasePattern(phrase);
      return pattern !== undefined && cueOccursOutsideOtherLiteral(
        pattern.source,
        windows,
      );
    }));
    if (cuePresent && !hasConstraintForPath(constraints, path)) return false;
  }
  return true;
}

function validateDeclaration(
  raw: unknown,
  request: DeclarationRequest,
): IntentWriteActionDraftV1[] | undefined {
  const parsed = declarationSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  const allowedNames = new Set(request.writeActionNames);
  const contracts = new Map((request.writeActionContracts ?? []).map((contract) => [contract.actionName, contract]));
  const seenActions = new Set<string>();
  const validatedWrites: IntentWriteActionDraftV1[] = [];
  for (const write of parsed.data.writeActions) {
    if (!allowedNames.has(write.actionName) || seenActions.has(write.actionName)) return undefined;
    seenActions.add(write.actionName);
    const contract = contracts.get(write.actionName);
    if (!contract) return undefined;

    const quoted = "sourceRefs" in write;
    const actionSpans = quoted
      ? write.sourceRefs.map((ref) => sourceSpanForQuote(ref, request.segments))
      : write.sourceSpans.map((span) => sourceTextForSpan(span, request.segments) === undefined ? undefined : span);
    if (actionSpans.some((span) => span === undefined)) return undefined;
    if (request.requireCurrentActionSpan) {
      const current = request.segments.find((segment) => segment.source === "current");
      if (!current || !actionSpans.some((span) => span !== undefined &&
        span.startByte < current.endByte && current.startByte < span.endByte)) return undefined;
    }

    const literalConstraints: Array<IntentWriteActionDraftV1["literalConstraints"][number]> = [];
    const constraintPaths = new Set<string>();
    for (const constraint of write.literalConstraints) {
      if (constraintPaths.has(constraint.path)) return undefined;
      constraintPaths.add(constraint.path);
      if (!pathIsLiteralControlled(constraint.path, contract)) return undefined;
      const sourceSpan = quoted
        ? sourceSpanForQuote((constraint as z.infer<typeof quotedConstraintSchema>).sourceRef, request.segments)
        : (constraint as z.infer<typeof legacyConstraintSchema>).sourceSpan;
      if (!sourceSpan) return undefined;
      const sourceText = sourceTextForSpan(sourceSpan, request.segments);
      if (sourceText === undefined) return undefined;
      const aliases = contract.semanticLiteralAliases.filter((alias) => alias.path === constraint.path);
      const value = normalizedLiteral(
        sourceText,
        constraint.value,
        aliases,
        sourceSpan,
        request.segments,
        contract.numericLiteralPaths.includes(normalizedConstraintPath(constraint.path)),
      );
      if (value === undefined) return undefined;
      if (literalConstraints.some((prior) =>
        prior.sourceSpan.startByte < sourceSpan.endByte && sourceSpan.startByte < prior.sourceSpan.endByte)) {
        return undefined;
      }
      literalConstraints.push({ path: constraint.path, value, sourceSpan });
      if (quoted && !actionSpans.some((span) => span?.startByte === sourceSpan.startByte &&
        span.endByte === sourceSpan.endByte && span.text === sourceSpan.text)) {
        actionSpans.push(sourceSpan);
      }
    }
    if (!satisfiesAuthoredIntent(
      write.actionName,
      contract.authoredIntent,
      actionSpans as SourceSpan[],
      literalConstraints,
      contract.semanticLiteralAliases,
      request.segments,
      request.requireCurrentActionSpan === true,
    )) {
      return undefined;
    }
    validatedWrites.push({
      actionName: write.actionName,
      sourceSpans: actionSpans as SourceSpan[],
      literalConstraints,
      maxExecutions: write.maxExecutions,
    });
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
  if (!request) {
    reportProvenance(input, "invalid");
    return denied;
  }
  const messages: ModelMessage[] = [
    declarationSystemMessage,
    { role: "user", content: JSON.stringify(request) },
  ];

  let raw: unknown;
  let provenance: IntentDeclarationProvenance;
  try {
    if (typeof input.modelClient.completeWithTools === "function") {
      const completion = await input.modelClient.completeWithTools(
        messages,
        [declarationTool(request.writeActionNames)],
        input.signal,
        { retryTransient: false },
      );
      const finishReasonContradictsCalls = completion.finishReason !== undefined && (
        (completion.toolCalls.length === 0 && completion.finishReason !== "stop") ||
        (completion.toolCalls.length > 0 && completion.finishReason !== "tool_calls")
      );
      if (finishReasonContradictsCalls) {
        reportProvenance(input, "invalid");
        return denied;
      }
      if (completion.toolCalls.length === 0) {
        // DeepSeek supports only automatic tool choice, so a completion may contain
        // no declaration call. Normalize only that exact zero-call shape to the
        // narrowest possible capability: no writes. This does not classify the
        // authored input as read-only, and provider text never supplies an action,
        // span, literal, or execution count.
        raw = { writeActions: [] };
        provenance = "local_empty_zero_tool";
      } else if (completion.toolCalls.length === 1 &&
        completion.toolCalls[0]?.name === DECLARE_INTENT_TOOL_NAME) {
        raw = completion.toolCalls[0].arguments;
        provenance = "provider_tool";
      } else {
        reportProvenance(input, "invalid");
        return denied;
      }
    } else {
      const completion = await input.modelClient.complete(
        messages,
        undefined,
        input.signal,
        { retryTransient: false },
      );
      raw = parseJsonDeclaration(completion);
      provenance = "provider_json";
    }
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    reportProvenance(input, "invalid");
    return denyCapability(input, "provider_unavailable");
  }

  const writeActions = validateDeclaration(raw, request);
  if (!writeActions) {
    reportProvenance(input, "invalid");
    return denied;
  }
  reportProvenance(input, provenance);
  if (writeActions.length === 0) return denyCapability(input, "no_write_intent");
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
