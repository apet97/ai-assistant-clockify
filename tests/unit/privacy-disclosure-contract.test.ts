import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";

/**
 * D8 — PRIVACY.md must account for EVERY table the shipped schema creates.
 *
 * The source of truth is the real migrated database, never a hand-kept list:
 * a new v2 table appears in `sqlite_master` the moment it ships, so it fails
 * this test until someone classifies it below AND (for a by-name row) writes
 * the disclosure. Inverting that — deriving the table list from the document —
 * would let a new table stay silently undisclosed forever.
 *
 * Two disclosure shapes are legitimate:
 *  - `named`: PRIVACY.md's retention table names the table in backticks. Used
 *    where the row's privacy story is specific to that table.
 *  - a category label: the exact `Data` cell of a PRIVACY.md retention row that
 *    covers the table without naming it. The label must exist in the document,
 *    so a typo or a deleted row fails here rather than passing vacuously.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const privacy = readFileSync(`${repositoryRoot}/PRIVACY.md`, "utf8");

/** The four v2 agent-runtime tables D8 disclosed. Named, not categorical. */
const V2_AGENT_TABLES = [
  "assistant_runs",
  "run_events",
  "entity_references",
  "pending_clarifications",
] as const;

const NAMED = "named" as const;

/** Every table the schema creates -> how PRIVACY.md accounts for it. */
const DISCLOSURE: Record<string, typeof NAMED | string> = {
  // The four v2 agent-runtime tables — disclosed by name (D8).
  assistant_runs: NAMED,
  run_events: NAMED,
  entity_references: NAMED,
  pending_clarifications: NAMED,

  // Installation, lifecycle, and anti-replay state.
  installations: "Installation token + lifecycle issuer watermark",
  installation_attestations: "Fresh-install release attestation",
  retired_installation_tokens: "Retired-token anti-replay fingerprint",
  lifecycle_authority_watermarks: "Lifecycle authority lineage",

  // Per-admin policy, transcripts, audit, sessions.
  admin_policies: "Admin permissions",
  chat_messages: "Chat transcripts",
  chat_message_result_links: "Chat transcripts",
  audit_events: "Audit log",
  chat_sessions: "Session records",

  // Confirmation, undo, telemetry, artifacts.
  pending_confirmations: "Pending confirmations",
  confirmation_batches: "Pending confirmations",
  confirmation_batch_items: "Pending confirmations",
  undo_records: "Undo records",
  turn_telemetry: "Turn telemetry",
  artifacts: "Export artifacts",

  // Durable safety/replay state — covered categorically, by design: these rows
  // hold canonical outcomes, capabilities, plans, journals and ordered links.
  action_results: "Durable safety/replay state",
  intent_capabilities: "Durable safety/replay state",
  intent_capability_usage: "Durable safety/replay state",
  idempotency_keys: "Durable safety/replay state",
  operation_runs: "Durable safety/replay state",
  operation_steps: "Durable safety/replay state",
  turn_runs: "Durable safety/replay state",
  turn_run_result_links: "Durable safety/replay state",
  turn_message_links: "Durable safety/replay state",
  assistant_run_request_links: "Durable safety/replay state",
  assistant_run_result_links: "Durable safety/replay state",

  // Operational evidence with no customer content. PRIVACY.md's retention
  // narrative states exactly what a retention pass persists.
  retention_runs: "Each retention pass persists only",
  readiness_probe: "Each retention pass persists only",
};

function migratedTableNames(): string[] {
  const db = new Database(":memory:");
  try {
    migrate(db);
    return db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    db.close();
  }
}

describe("D8: PRIVACY.md accounts for every table the schema creates", () => {
  it("classifies every migrated table — a new table cannot ship unclassified", () => {
    const actual = migratedTableNames();
    const classified = Object.keys(DISCLOSURE).sort();

    // Both directions: an unclassified new table AND a classification for a
    // table that no longer exists are failures.
    expect(actual).toEqual(classified);
  });

  it("resolves every classification against real PRIVACY.md text", () => {
    const unresolved: string[] = [];

    for (const table of migratedTableNames()) {
      const disclosure = DISCLOSURE[table];
      if (disclosure === undefined) {
        unresolved.push(`${table}: no disclosure classification`);
        continue;
      }
      if (disclosure === NAMED) {
        if (!privacy.includes(`\`${table}\``)) {
          unresolved.push(`${table}: PRIVACY.md does not name \`${table}\``);
        }
        continue;
      }
      if (!privacy.includes(disclosure)) {
        unresolved.push(`${table}: PRIVACY.md has no "${disclosure}" disclosure`);
      }
    }

    expect(unresolved).toEqual([]);
  });

  it("gives each v2 agent table its own retention-table row and a retention window", () => {
    // Pull the retention table's rows so a table name mentioned only in prose
    // elsewhere cannot satisfy this.
    const rows = privacy
      .split("\n")
      .filter((line) => line.startsWith("| ") && line.endsWith(" |") && !line.startsWith("|---"));

    const problems: string[] = [];
    for (const table of V2_AGENT_TABLES) {
      const row = rows.find((line) => line.includes(`\`${table}\``));
      if (!row) {
        problems.push(`${table}: no retention-table row`);
        continue;
      }
      const cells = row.slice(2, -2).split(" | ");
      if (cells.length !== 3) {
        problems.push(`${table}: row is not a 3-column retention row`);
        continue;
      }
      const [, purpose, retention] = cells;
      if (purpose.trim().length < 40) problems.push(`${table}: purpose is not stated`);
      // Every window must resolve to a real duration, not "see above".
      if (!/\b(minutes?|days?|hours?)\b/.test(retention)) {
        problems.push(`${table}: retention states no measurable window`);
      }
    }

    expect(problems).toEqual([]);
  });

  it("lists the v2 agent data in the uninstall erasure enumeration", () => {
    // installations.ts erases all four on uninstall; disclosing storage without
    // disclosing erasure is the worse half-fix.
    const deletionSection = privacy.slice(privacy.indexOf("## Deletion & your rights"));
    expect(deletionSection).not.toBe("");

    const missing = [
      "agent run records",
      "run_events",
      "entity references",
      "pending clarifications",
    ].filter((phrase) => !deletionSection.toLowerCase().includes(phrase.toLowerCase()));

    expect(missing).toEqual([]);
  });

  it("does not claim a model vendor the repository pins", () => {
    // The repo has no default LLM_BASE_URL/LLM_MODEL, so a bare "version N
    // sends model turns to <vendor>" would assert what nothing attests. The
    // disclosure must name the configured-endpoint boundary as well.
    const subprocessors = privacy.slice(privacy.indexOf("## Sub-processors"));
    expect(subprocessors).toContain("LLM_BASE_URL");
    expect(subprocessors).toContain("LLM_MODEL");
    // ...and must still name where data actually goes today.
    expect(subprocessors).toContain("DeepSeek");
  });
});
