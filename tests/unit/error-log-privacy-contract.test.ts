import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyLoggableError } from "../../src/log-error-class.js";

/**
 * D5 source/runtime contract for PRODUCTION ERROR LOGS, modelled on
 * `tests/unit/english-interface-contract.test.ts` (the repo's other independent
 * source-boundary pin).
 *
 * Why a source scan rather than only a behavioural test: a caught value's
 * `.message` is attacker-reachable through paths that no single integration
 * test enumerates. Two are proven, not hypothesised:
 *
 *  - body-parser's `entity.parse.failed` carries V8's JSON.parse message, and
 *    V8 quotes the offending bytes VERBATIM — `Unexpected token 'd',
 *    "delete eve"... is not valid JSON` for an admin-authored prompt, and
 *    `...\"7c26fe4\", eyJhbGciOi\"...` for a body holding a workspace id and a
 *    token. Both are pinned live in
 *    `tests/integration/request-error-log-privacy.test.ts`.
 *  - `ZodError.message` is a JSON dump whose `received` field echoes the
 *    rejected value and whose `unrecognized_keys` lists the submitted keys.
 *
 * So the rule is structural, not per-source: no production log line may branch
 * on Error-ness, read `.message`, or hand a caught binding to a log sink. The
 * only thing a log line may carry about a caught value is the bounded
 * classification from `src/log-error-class.ts`.
 *
 * The pair below is what makes this durable. (1) reintroducing a raw-message
 * log fails the scan; (2) deleting the promise from PRIVACY.md fails the
 * document pin. Neither can drift alone.
 *
 * EXACTLY WHAT THE GUARD COVERS, so nobody reads it as more:
 *
 *  - It reads the ARGUMENT TEXT of two callee shapes — `console.<anything>(…)`
 *    and a bare `log(…)`, the repo's injected sink. Every check is
 *    binding-agnostic; no check depends on an error being named `err`.
 *  - It follows ONE laundering hop: an identifier bound from `.message` or
 *    `String(x)` earlier in the same file is forbidden inside a sink argument.
 *    That is file-scoped by name, not scope-accurate, so it over-approximates.
 *  - It does NOT do real dataflow. A value passed through a helper function, or
 *    laundered across two files, is not tracked. `classifyLoggableError` being
 *    the only permitted reader is what makes that gap small: any other path to
 *    a message has to name `.message` somewhere the scan can see.
 *  - It does NOT cover anything but logs. Errors persisted to the database
 *    (`harness/mutation-workflow.ts` `safeFailureDetail`) deliberately keep
 *    their message; PRIVACY.md states that separately.
 *  - The PRIVACY.md pin is DELETION-ONLY: it asserts the claim sentences are
 *    present. It cannot detect a claim that is present but has drifted from
 *    behaviour — that is what the source scan is for, and the two are meant to
 *    be read together.
 */

const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));
const PRIVACY = readFileSync(new URL("../../PRIVACY.md", import.meta.url), "utf8");

/**
 * `src/ui/` is excluded on purpose and the exclusion is part of the claim, not
 * a loophole: it is bundled to the BROWSER, so its `console` writes land in the
 * admin's own devtools on the admin's own machine — never in the server's
 * operator log, which is the sink PRIVACY.md describes. `src/ui/main.ts:740`
 * is the one such site and it is deliberately left alone.
 */
const EXCLUDED_DIRECTORIES = new Set(["ui"]);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name) && directory === SRC_ROOT) continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

/** Index just past the closing delimiter of the string starting at `start`. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    // A template interpolation reopens ordinary code, so its own quotes and
    // parentheses have to be walked rather than swallowed.
    if (quote === "`" && ch === "$" && source[index + 1] === "{") {
      index = skipBraces(source, index + 1);
      continue;
    }
    if (ch === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

/** Index just past the `}` matching the `{` at `start`. */
function skipBraces(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      index = skipString(source, index);
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
}

/**
 * Blank out comment bodies while preserving offsets and newlines. Comments are
 * where this contract is EXPLAINED (`server.ts` says "never `err.message`"), so
 * scanning them would flag the documentation of the rule as a violation of it.
 */
function stripComments(source: string): string {
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      index = skipString(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        out[index] = " ";
        index += 1;
      }
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      for (let cursor = index; cursor < stop; cursor += 1) {
        if (out[cursor] !== "\n") out[cursor] = " ";
      }
      index = stop;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

interface SinkCall {
  line: number;
  args: string;
  /** Text before the call — used to recognize the injected-sink adapter shape. */
  preceding: string;
}

/**
 * Index of the `(` opening a call whose callee ends at `calleeEnd`, and the
 * index of its matching `)`. Strings and template interpolations are respected
 * so a `)` inside either cannot end the call early.
 */
function callArguments(code: string, open: number): { args: string; end: number } {
  let depth = 0;
  let cursor = open;
  while (cursor < code.length) {
    const ch = code[cursor];
    if (ch === '"' || ch === "'" || ch === "`") {
      cursor = skipString(code, cursor);
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    cursor += 1;
  }
  return { args: code.slice(open + 1, cursor), end: cursor };
}

/**
 * Every LOG-SINK call in a file. Two callee shapes count, and the second one
 * matters as much as the first:
 *
 *  - `console.<anything>(…)` — covers `error`/`warn`/`log`, and equally
 *    `debug`/`info`/`trace`, because the callee is matched by prefix.
 *  - a bare `log(…)` — the repo's uniform name for the INJECTED sink
 *    (`const log = input.log ?? ((line: string) => console.warn(line))`) used by
 *    `log-outcome-unknown`, `log-artifact-oversize`, `readiness-alerts`,
 *    `retention-alerts`, `operator-health`, both `clockify/*-monitor`s, and two
 *    loops in `server.ts`. Their `console` call receives a bare parameter, so
 *    scanning only `console` args would leave eight sinks effectively unchecked
 *    — the line is built at the `log(` call site, so that is where it is read.
 */
function sinkCalls(source: string): SinkCall[] {
  const code = stripComments(source);
  const calls: SinkCall[] = [];
  let index = 0;
  while (index < code.length) {
    const ch = code[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      index = skipString(code, index);
      continue;
    }
    const isConsole = code.startsWith("console.", index)
      && (index === 0 || !/[A-Za-z0-9_$.]/u.test(code[index - 1] ?? ""));
    // A bare `log(`: not `console.log(`, not `Math.log(`, not `catalog(`.
    const isInjectedSink = code.startsWith("log", index)
      && /^log\s*\(/u.test(code.slice(index))
      && (index === 0 || !/[A-Za-z0-9_$.]/u.test(code[index - 1] ?? ""));
    if (!isConsole && !isInjectedSink) {
      index += 1;
      continue;
    }
    const open = code.indexOf("(", index);
    if (open < 0) break;
    const { args, end } = callArguments(code, open);
    calls.push({
      line: code.slice(0, index).split("\n").length,
      args,
      preceding: code.slice(0, index),
    });
    index = end + 1;
  }
  return calls;
}

/** Split an argument list on TOP-LEVEL commas only. */
function topLevelArguments(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < args.length) {
    const ch = args[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      index = skipString(args, index);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(args.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  out.push(args.slice(start));
  return out.map((argument) => argument.trim()).filter((argument) => argument.length > 0);
}

const LONE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
/** `((line: string) => console.warn(` — the injected-sink adapter, and only that. */
const SINK_ADAPTER = /\(\s*([A-Za-z_$][\w$]*)\s*:\s*string\s*\)\s*=>\s*$/u;

/**
 * Identifiers bound from a caught value earlier in the SAME FILE. Without this,
 * `const detail = err.message; console.warn(`x ${detail}`)` launders the message
 * past every argument-text pattern. File-scoped by name rather than
 * scope-accurate, which can only ever over-approximate — and the repo scan below
 * passes with an EMPTY allowlist, so the approximation costs nothing today.
 */
function laundered(code: string): Set<string> {
  const tainted = new Set<string>();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]*)/gu;
  for (const match of code.matchAll(declaration)) {
    const value = match[2] ?? "";
    if (/\.message\b/u.test(value) || /\bString\(\s*[A-Za-z_$][\w$]*\s*\)/u.test(value)) {
      tainted.add(match[1]!);
    }
  }
  return tainted;
}

/**
 * The rule, stated once and applied to every sink call: a log line may not
 * decide what to print by inspecting a caught value, may not print the value,
 * and may not print anything derived from its message.
 * `classifyLoggableError` is the ONE permitted reader of a caught value on a
 * logging path — it takes `unknown`, so nothing here needs to know binding
 * names, and every check below is deliberately binding-AGNOSTIC.
 */
export function logSinkViolations(source: string): string[] {
  const code = stripComments(source);
  const tainted = laundered(code);
  const violations: string[] = [];
  for (const call of sinkCalls(source)) {
    const report = (why: string): void => { violations.push(`${call.line} ${why}`); };
    if (/\.message\b/u.test(call.args)) report("reads .message");
    if (/\binstanceof\s+Error\b/u.test(call.args)) report("branches on Error-ness");
    // Any identifier, not a list of conventional names: `String(e)` and
    // `String(settlementError)` are the same defect.
    if (/\bString\(\s*[A-Za-z_$][\w$]*\s*\)/u.test(call.args)) report("stringifies a binding");
    for (const argument of topLevelArguments(call.args)) {
      if (!LONE_IDENTIFIER.test(argument)) continue;
      // The sole exemption, and it is structural rather than a name list: an
      // adapter whose parameter is TYPED `string` is forwarding a line some
      // caller already built, and that caller's `log(` site is scanned above.
      const adapter = SINK_ADAPTER.exec(call.preceding);
      if (adapter && adapter[1] === argument) continue;
      report(`passes the bare binding \`${argument}\``);
    }
    for (const name of tainted) {
      if (new RegExp(`\\b${name}\\b`, "u").test(call.args)) report(`prints \`${name}\`, bound from a caught value`);
    }
  }
  return violations;
}

const allFiles = sourceFiles(SRC_ROOT);

describe("production error-log privacy contract", () => {
  it("scans every server source file and finds every sink call", () => {
    expect(allFiles.length).toBeGreaterThan(50);
    let naiveConsole = 0;
    let extracted = 0;
    for (const file of allFiles) {
      const code = stripComments(readFileSync(file, "utf8"));
      naiveConsole += (code.match(/console\./gu) ?? []).length;
      extracted += sinkCalls(readFileSync(file, "utf8")).length;
    }
    // Self-check: a scanner that silently loses calls would make every
    // assertion below vacuous. Every `console.` must be found, and the injected
    // `log(` sites are found ON TOP of them.
    expect(extracted).toBeGreaterThan(naiveConsole);
    expect(naiveConsole).toBeGreaterThan(30);
  });

  it("has no server log line that reads, stringifies, or branches on a caught value", () => {
    const violations: string[] = [];
    for (const file of allFiles) {
      for (const violation of logSinkViolations(readFileSync(file, "utf8"))) {
        violations.push(`${relative(SRC_ROOT, file)}:${violation}`);
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * The guard's own acceptance test. Every shape below is a real way to put a
   * caught value into a log; an earlier revision of this guard hard-coded six
   * binding names and FIVE of these slipped through — including
   * `settlementError`, the live binding name at `routes/control-plane.ts` and
   * two sites in `services/confirmation-service.ts`, so reverting three of the
   * twelve fixed sites would have passed silently.
   */
  const LEAK_SHAPES: Array<{ id: string; source: string }> = [
    { id: "a HEAD's own shape", source: 'console.error("x:", err instanceof Error ? err.message : String(err));' },
    { id: "b String() in a template", source: "console.warn(`x ${String(e)}`);" },
    { id: "c bare binding, short name", source: 'console.log("y", e);' },
    { id: "d bare binding, domain name", source: 'console.error("x", settlementError);' },
    { id: "e direct .message", source: 'console.error("x:", error.message);' },
    { id: "f laundered through a const", source: "const d = err.message;\nconsole.log(`${d}`);" },
    { id: "g .message in a template", source: "console.info(`x ${err.message}`);" },
    { id: "h console.debug, unconventional name", source: "console.debug(caught);" },
    { id: "i console.trace with String()", source: 'console.trace("x", String(reason));' },
    { id: "j .message nested in an object", source: 'console.error("x", { detail: e.message });' },
  ];

  it.each(LEAK_SHAPES)("catches leak shape $id", ({ source }) => {
    expect(logSinkViolations(source)).not.toEqual([]);
  });

  /**
   * ...and the other half of a guard that means something: shapes it must NOT
   * flag. Without these, "flag everything" would pass the matrix above.
   */
  const PERMITTED_SHAPES: Array<{ id: string; source: string }> = [
    { id: "the classifier", source: "console.error(`request error: ${classifyLoggableError(err)} status=${status}`);" },
    { id: "the injected-sink adapter", source: "const log = deps.log ?? ((line: string) => console.log(line));" },
    { id: "a fixed suppressed line", source: 'console.error("assistant-reply persistence failed (error details suppressed)");' },
    { id: "an aliased id", source: 'console.log(`[lifecycle] event=installed addon=${addonAlias(String(body.addonId ?? claims.addonId ?? ""))}`);' },
    { id: "a built emitter line", source: "log(`[storage] event=sqlite_unavailable kind=${input.kind} site=${input.site}`);" },
    { id: "structured counts", source: 'console.error("degraded; response preserved", { status, attempts });' },
  ];

  it.each(PERMITTED_SHAPES)("does not flag permitted shape $id", ({ source }) => {
    expect(logSinkViolations(source)).toEqual([]);
  });

  it("keeps the browser-console exclusion honest — it is scoped to src/ui only", () => {
    // If the exclusion ever widened, the claim in PRIVACY.md would silently
    // stop covering server code. Pin both the exclusion set and the fact that
    // the excluded file really is browser-bundled.
    expect([...EXCLUDED_DIRECTORIES]).toEqual(["ui"]);
    // The trailing separator matters: `src/ui-preferences.ts` is a SERVER file
    // and must stay in scope, so the exclusion is the directory, not a prefix.
    expect(allFiles.some((file) => file.includes(`${join("src", "ui")}${sep}`))).toBe(false);
    expect(allFiles.some((file) => file.endsWith(`${sep}ui-preferences.ts`))).toBe(true);
    expect(readFileSync(new URL("../../src/ui/main.ts", import.meta.url), "utf8"))
      .toContain("document");
  });
});

describe("classifyLoggableError", () => {
  const WORKSPACE_ID = "64ad1305c701cc5be7c26fe4";
  const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJ3b3Jrc3BhY2VJZCI6IngifQ.sig";
  const PROMPT = "delete every time entry for Ana before Friday";

  it("keeps a driver failure to its type and code", () => {
    const error = Object.assign(
      new Error(`attempt to write a readonly database: UPDATE installations SET t='${JWT}' WHERE ws='${WORKSPACE_ID}'`),
      { name: "SqliteError", code: "SQLITE_READONLY" },
    );
    expect(classifyLoggableError(error)).toBe("name=SqliteError code=SQLITE_READONLY");
  });

  it("keeps a body-parser failure to its type and body-parser kind", () => {
    const error = Object.assign(new SyntaxError(`Unexpected token 'd', "${PROMPT.slice(0, 10)}"... is not valid JSON`), {
      status: 400,
      type: "entity.parse.failed",
      body: PROMPT,
    });
    expect(classifyLoggableError(error)).toBe("name=SyntaxError type=entity.parse.failed");
  });

  it("refuses a hostile name, code, or type whole rather than squashing it", () => {
    // Squashing to a safe charset would still pass a readable phrase through
    // ("delete every entry" -> "deleteeveryentry"), and a forged newline would
    // let an error mint a second, fake operator line. Refusal emits no bytes.
    const error = Object.assign(new Error("boom"), {
      name: PROMPT,
      code: `${WORKSPACE_ID} ${JWT}`,
      type: "\n[storage] event=sqlite_unavailable kind=readonly site=readiness",
    });
    expect(classifyLoggableError(error)).toBe("name=unclassified code=unclassified type=unclassified");
  });

  it("refuses an over-long field even when its characters are identifier-shaped", () => {
    const error = Object.assign(new Error("boom"), { code: WORKSPACE_ID.repeat(3) });
    expect(classifyLoggableError(error)).toBe("name=Error code=unclassified");
  });

  it("walks exactly one cause, so a wrapper does not erase the real discriminator", () => {
    const driver = Object.assign(
      new Error(`attempt to write a readonly database: UPDATE installations SET t='${JWT}' WHERE ws='${WORKSPACE_ID}'`),
      { name: "SqliteError", code: "SQLITE_BUSY" },
    );
    const wrapper = new Error("turn failed", { cause: driver });
    expect(classifyLoggableError(wrapper)).toBe("name=Error cause=[name=SqliteError code=SQLITE_BUSY]");

    // Depth 1 exactly: a long chain cannot grow the line without bound, and the
    // second level is still classified rather than printed.
    const nested = new Error("outer", { cause: new Error("middle", { cause: driver }) });
    expect(classifyLoggableError(nested)).toBe("name=Error cause=[name=Error]");
    expect(classifyLoggableError(new Error("x", { cause: PROMPT }))).toBe("name=Error cause=[thrown=string]");
  });

  it("emits producer-declared safe detail, still gated on shape", () => {
    const named = Object.assign(new Error("env invalid"), {
      name: "ZodError",
      logSafeDetail: "SESSION_SECRET,LLM_PROVIDER",
    });
    expect(classifyLoggableError(named)).toBe("name=ZodError issues=SESSION_SECRET,LLM_PROVIDER");

    // A producer that puts a VALUE on the channel gets refused, not trusted.
    const abused = Object.assign(new Error("x"), { logSafeDetail: `${PROMPT} ${JWT}` });
    expect(classifyLoggableError(abused)).toBe("name=Error issues=unclassified");
  });

  it("reports a non-Error throw by shape only, never by value", () => {
    expect(classifyLoggableError(`${PROMPT} ${JWT}`)).toBe("thrown=string");
    expect(classifyLoggableError({ message: PROMPT })).toBe("thrown=object");
    expect(classifyLoggableError(undefined)).toBe("thrown=undefined");
    expect(classifyLoggableError(null)).toBe("thrown=object");
  });
});

/**
 * Prose reflows and carries markdown emphasis, so match on the SENTENCE rather
 * than the byte layout: collapse whitespace and drop `**`. Nothing else is
 * normalized — the wording itself still has to survive verbatim.
 */
const privacyProse = PRIVACY.replaceAll("**", "").replace(/\s+/gu, " ");

describe("PRIVACY.md error-log claim", () => {
  it("still carries the operational-log promise the code implements", () => {
    // Deleting or softening any of these fails here, so the document cannot
    // drift away from the scan above.
    expect(PRIVACY).toContain("## Server operational logs");
    expect(privacyProse).toContain(
      "no server log line — request-error, background-task, or crash — carries the caught value's message text",
    );
    expect(privacyProse).toContain(
      "bounded classification: the error's type name plus its driver, HTTP, or parser code",
    );
    expect(privacyProse).toContain(
      "The HTTP response returned to the caller carries even less: a fixed sentence and the status code, never the error.",
    );
  });

  it("states the two limits instead of overclaiming", () => {
    // The promise must not read wider than the code. Both carve-outs are real
    // and both are verified against source in the assertions below.
    expect(privacyProse).toContain(
      "Clockify request paths, which contain workspace and entity ids, do appear in the list-pagination backstop warning",
    );
    // NOT "sanitized" — nothing redacts it. The document has to say bounded, and
    // say what the bound actually is.
    expect(privacyProse).toContain(
      "Durable operation rows — in the database, not the log — retain the failure message itself",
    );
    expect(privacyProse).toContain("but it is not redacted");
    expect(privacyProse).not.toContain("retain a sanitized failure message");
    const restSources = sourceFiles(join(SRC_ROOT, "clockify", "rest"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(restSources).toContain("-page backstop (${");
    // The stated 200-byte bound is the adapter's, not a hopeful number.
    expect(restSources).toContain("text.slice(0, 200)");
    // The provider correlation id is the one third-party-controlled value on an
    // alert line, so the document's claim that it is bounded must be real.
    expect(privacyProse).toContain("bounded to an identifier shape at the source");
    expect(readFileSync(new URL("../../src/assistant/model-client.ts", import.meta.url), "utf8"))
      .toContain("BOUNDED_PROVIDER_REQUEST_ID");
    expect(readFileSync(new URL("../../src/harness/mutation-workflow.ts", import.meta.url), "utf8"))
      .toContain("function safeFailureDetail(");
  });

  it("keeps the narrower provider-error promise, which is a different sink", () => {
    expect(PRIVACY).toContain("excluded from production provider-error logs");
    // ...and points at the wider section, so the narrow scoping cannot be read
    // as "provider logs are the only logs".
    expect(privacyProse).toContain("Server operational logs below states what every other one contains");
  });
});
