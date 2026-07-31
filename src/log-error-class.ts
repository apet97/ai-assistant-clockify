/**
 * The ONE thing a production log line may say about a caught value.
 *
 * A caught `unknown` is not safe to print. Two carriers are proven, not
 * theoretical:
 *
 *  - body-parser's `entity.parse.failed` wraps V8's `JSON.parse` message, and
 *    V8 quotes the offending bytes VERBATIM — a malformed chat body yields
 *    `Unexpected token 'd', "delete eve"... is not valid JSON`, and a body
 *    holding an id and a token yields `..."7c26fe4", eyJhbGciOi"...`. That
 *    error reaches the terminal handler BY DESIGN, because the handler exists
 *    to honor its 400.
 *  - `ZodError.message` is a JSON dump whose `received` echoes the rejected
 *    value and whose `unrecognized_keys` lists the submitted key names.
 *
 * The REST adapter adds a third: `rest/core.ts` builds `Clockify ${method}
 * ${path} -> ${status}: ${body.slice(0, 200)}`, where the path carries the raw
 * workspace and entity ids and the tail carries host response bytes.
 *
 * So the classification is derived only from fields that describe the failure's
 * KIND — never from `message`, `stack`, `cause`, or any payload the error
 * captured. Each field is additionally REJECTED WHOLE unless it already looks
 * like a bounded identifier. Squashing a field to a safe charset would still
 * pass a readable phrase through (`delete every entry` → `deleteeveryentry`);
 * refusing it emits a fixed marker instead, so a hypothetical attacker-set
 * `name`/`code`/`type` yields no bytes at all rather than compressed ones.
 *
 * Deliberately imports nothing: every layer logs (server, routes, services,
 * harness, assistant-v2), so a leaf keeps `npm run cycles` at 0.
 */

/** Long enough for `SQLITE_CONSTRAINT_PRIMARYKEY` and `entity.parse.failed`. */
const MAX_FIELD_LENGTH = 48;

/**
 * The shape every real classifier field already has: driver codes
 * (`SQLITE_BUSY`), Node codes (`ERR_STREAM_PREMATURE_CLOSE`), constructor names
 * (`PayloadTooLargeError`), and body-parser kinds (`entity.parse.failed`). No
 * whitespace, so a refused field can never forge a second log line either.
 */
const BOUNDED_FIELD = /^[A-Za-z0-9_.-]+$/u;

/** A field that existed but did not look like a classifier — reported, never echoed. */
const REFUSED = "unclassified";

function boundedField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= MAX_FIELD_LENGTH && BOUNDED_FIELD.test(value) ? value : REFUSED;
}

/**
 * The opt-in channel for detail a PRODUCER can prove is safe, used by
 * `config.ts` to name the offending environment variables without printing the
 * validator's message. Wider than a single field (it is a list) and still
 * whitelisted here rather than trusted: a producer that gets it wrong emits
 * `unclassified`, not its payload.
 *
 * Set `logSafeDetail` only from values the SCHEMA controls — key names, issue
 * paths, enum members — never from a value a request or a host supplied.
 */
const MAX_DETAIL_LENGTH = 160;
const BOUNDED_DETAIL = /^[A-Za-z0-9_.,-]+$/u;

function boundedDetail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= MAX_DETAIL_LENGTH && BOUNDED_DETAIL.test(value) ? value : REFUSED;
}

/**
 * One level of `cause` is walked, and only one. A wrapper Error whose cause is
 * the real `SQLITE_BUSY` would otherwise classify as a bare `name=Error` and
 * tell an operator nothing — the failure mode that matters most on
 * `uncaughtException`, where the process is about to exit. Deeper chains are
 * not walked: the first cause is where the discriminator lives, and an
 * unbounded walk would let a long chain grow the line without limit.
 */
const CAUSE_DEPTH = 1;

/**
 * A bounded, secret-free classification of a caught value, for operator logs.
 *
 * Emits `name=<constructor name>` plus, when present, `code=<driver/Node code>`
 * (`SQLITE_BUSY`, `ENOENT`), `type=<body-parser kind>` (`entity.parse.failed`,
 * `entity.too.large`), `issues=<producer-declared safe detail>`, and
 * `cause=[…]` — the discriminators a runbook actually alerts on. A non-Error
 * throw is reported by `typeof` alone, because its value is entirely
 * caller-controlled.
 */
export function classifyLoggableError(value: unknown): string {
  return classifyAtDepth(value, CAUSE_DEPTH);
}

function classifyAtDepth(value: unknown, remainingCauseDepth: number): string {
  if (!(value instanceof Error)) return `thrown=${typeof value}`;
  const parts = [`name=${boundedField(value.name) ?? "Error"}`];
  // Each field is omitted when absent — an operator reads that absence as
  // "this failure carried no such discriminator", which is true.
  const code = boundedField((value as { code?: unknown }).code);
  if (code !== undefined) parts.push(`code=${code}`);
  const type = boundedField((value as { type?: unknown }).type);
  if (type !== undefined) parts.push(`type=${type}`);
  const detail = boundedDetail((value as { logSafeDetail?: unknown }).logSafeDetail);
  if (detail !== undefined) parts.push(`issues=${detail}`);
  // Bracketed so a consumer can tell the wrapper's fields from the cause's.
  const cause: unknown = (value as { cause?: unknown }).cause;
  if (remainingCauseDepth > 0 && cause !== undefined) {
    parts.push(`cause=[${classifyAtDepth(cause, remainingCauseDepth - 1)}]`);
  }
  return parts.join(" ");
}
