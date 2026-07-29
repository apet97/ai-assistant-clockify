import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import request from "supertest";
import {
  composeV2ProductionApp,
  discoverThenCall,
} from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 2 (F01 identity half): every successful v2 request has an
 * explicit request → run → user message → assistant message chain, and
 * retries cannot duplicate any node. Raw SQL assertions use the file-backed
 * database because the Store facade deliberately exposes no reader for the
 * identity link tables.
 */

const SEED = {
  entries: [
    {
      id: "e1",
      description: "spec work",
      start: "2026-07-25T09:00:00Z",
      end: "2026-07-25T10:00:00Z",
      billable: true,
    },
  ] as never,
};

const READ_SCRIPT = discoverThenCall(
  "list time entries",
  { name: "clockify_entries_list", arguments: {} },
  "You tracked one hour of spec work.",
);

function rawRows(databaseFile: string, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  const db = new Database(databaseFile, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("v2 request/run/message identity", () => {
  it("links one request to one run, one user message, and one assistant message", async () => {
    const c = await composeV2ProductionApp({ script: READ_SCRIPT, seed: SEED, fileBacked: true });
    const requestId = randomUUID();

    const res = await c.chat("what did I track yesterday?", { requestId });
    expect(res.status).toBe(200);
    expect(res.body.reply.text).toBe("You tracked one hour of spec work.");

    // The transcript is durable and ordered: one user bubble, one assistant
    // bubble carrying the model's own answer.
    const history = await request(c.app).get("/api/chat/history").set("Cookie", c.cookie);
    expect(history.status).toBe(200);
    expect(history.body.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ["user", "what did I track yesterday?"],
      ["assistant", "You tracked one hour of spec work."],
    ]);

    // The initial request link binds the CLIENT request id to a DIFFERENT
    // server-minted run id.
    const links = rawRows(
      c.databaseFile!,
      "SELECT request_id, run_id, kind FROM assistant_run_request_links WHERE kind = 'initial'",
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.request_id).toBe(requestId);
    expect(links[0]!.run_id).not.toBe(requestId);
    expect(links[0]!.run_id).toBe(c.latestRunId());

    // Both messages are owned by the claimed request, by id.
    const owned = rawRows(
      c.databaseFile!,
      `SELECT l.role, m.content FROM turn_message_links l
         JOIN chat_messages m ON m.id = l.message_id
        WHERE l.request_id = ? ORDER BY l.role DESC`,
      requestId,
    );
    expect(owned).toEqual([
      { role: "user", content: "what did I track yesterday?" },
      { role: "assistant", content: "You tracked one hour of spec work." },
    ]);

    // The assistant message carries ordered canonical result links — ids, not
    // copied outcomes.
    const resultLinks = rawRows(
      c.databaseFile!,
      `SELECT r.descriptor_kind, r.action_result_id FROM chat_message_result_links r
         JOIN turn_message_links l ON l.message_id = r.message_id
        WHERE l.request_id = ? AND l.role = 'assistant'`,
      requestId,
    );
    expect(resultLinks).toHaveLength(1);
    expect(resultLinks[0]!.descriptor_kind).toBe("action_result");
    expect(typeof resultLinks[0]!.action_result_id).toBe("string");
  });

  it("replays the same request id + text without duplicating any node", async () => {
    const c = await composeV2ProductionApp({ script: READ_SCRIPT, seed: SEED, fileBacked: true });
    const requestId = randomUUID();

    const first = await c.chat("what did I track yesterday?", { requestId });
    expect(first.status).toBe(200);
    const providerCallsAfterFirst = c.providerCalls();

    const replay = await c.chat("what did I track yesterday?", { requestId });
    expect(replay.status).toBe(200);
    expect(replay.body.reply.text).toBe("You tracked one hour of spec work.");

    // No re-execution and no duplicated transcript/run/link rows.
    expect(c.providerCalls()).toBe(providerCallsAfterFirst);
    expect(rawRows(c.databaseFile!, "SELECT id FROM chat_messages")).toHaveLength(2);
    expect(rawRows(c.databaseFile!, "SELECT run_id FROM assistant_runs")).toHaveLength(1);
    expect(rawRows(c.databaseFile!, "SELECT message_id FROM turn_message_links")).toHaveLength(2);
  });

  it("rejects the same request id with different text and creates nothing", async () => {
    const c = await composeV2ProductionApp({ script: READ_SCRIPT, seed: SEED, fileBacked: true });
    const requestId = randomUUID();

    await c.chat("what did I track yesterday?", { requestId });
    const conflict = await c.chat("delete every project", { requestId });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("operation_id_conflict");

    expect(rawRows(c.databaseFile!, "SELECT id FROM chat_messages")).toHaveLength(2);
    expect(rawRows(c.databaseFile!, "SELECT run_id FROM assistant_runs")).toHaveLength(1);
  });

  it("gives a clarification continuation its own owned user message on the same run", async () => {
    const c = await composeV2ProductionApp({
      script: [
        ...discoverThenCall("list time entries", {
          name: "clockify_entries_list",
          arguments: { start: "not-a-real-date" },
        }).slice(0, 2),
        { text: "Here is yesterday.", toolCalls: [] },
      ],
      seed: SEED,
      fileBacked: true,
    });
    const initialRequestId = randomUUID();
    await c.chat("list entries since not-a-real-date", { requestId: initialRequestId });
    const runId = c.activeRunId();

    const continuationRequestId = randomUUID();
    const continued = await c.chat("use yesterday instead", {
      requestId: continuationRequestId,
      continuationRunId: runId,
    });
    expect(continued.status).toBe(200);

    // Still ONE run; the continuation linked its own request and user message.
    expect(rawRows(c.databaseFile!, "SELECT run_id FROM assistant_runs")).toHaveLength(1);
    const links = rawRows(
      c.databaseFile!,
      "SELECT request_id, run_id, kind FROM assistant_run_request_links ORDER BY kind",
    );
    expect(links).toEqual([
      { request_id: continuationRequestId, run_id: runId, kind: "free_text_continuation" },
      { request_id: initialRequestId, run_id: runId, kind: "initial" },
    ]);
    const continuationMessages = rawRows(
      c.databaseFile!,
      `SELECT l.role, m.content FROM turn_message_links l
         JOIN chat_messages m ON m.id = l.message_id
        WHERE l.request_id = ? ORDER BY l.role DESC`,
      continuationRequestId,
    );
    expect(continuationMessages).toEqual([
      { role: "user", content: "use yesterday instead" },
      { role: "assistant", content: "Here is yesterday." },
    ]);
  });
});
