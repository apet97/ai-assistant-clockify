/**
 * Conversational repro harness — drives a MULTI-TURN chat through the REAL route
 * (`POST /api/chat/messages` on the real Express app) with the LIVE model
 * (LLM_* from the env file) against the in-memory fake workspace. No Clockify
 * calls. This is the "thing to talk to" for dogfooding the deployed behaviour
 * locally: it reproduces the production pipeline (truthful-preview override,
 * typed-consent guard, history window + sanitization, the agentic loop, the
 * NDJSON-shaped results) so we can collect real behavioural data and confirm
 * fixes.
 *
 * A conversation is JSON on stdin or a file arg:
 *   {
 *     "addon": true,                 // force authClass="addon" (prod restrictions)
 *     "seed": { "projects": [...], "tags": [...] },   // fake workspace seed
 *     "steps": [ "user message", { "undoLast": true }, "another message" ]
 *   }
 *
 * Run:
 *   echo '{"steps":["show this week summary"]}' | npx tsx --env-file=.env.server scripts/repro-chat.ts
 *   npx tsx --env-file=.env.server scripts/repro-chat.ts conversation.json
 */
import { readFileSync } from "node:fs";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { createApp } from "../src/server.js";
import { createSignatureParser } from "../src/addon/verify.js";
import { createStore } from "../src/db/store.js";
import type { AppConfig } from "../src/config.js";
import { selectModelClient, type ModelClientSelection } from "../src/assistant/select-model-client.js";
import type { ModelClient } from "../src/assistant/model-client.js";
import { createFakeWorkspace } from "../tests/helpers/fake-clockify.js";

const ADDON_KEY = "ai-assistant";

type Step = string | { undoLast: true };
interface Conversation {
  addon?: boolean;
  seed?: Record<string, unknown>;
  steps: Step[];
}

interface TurnResult {
  kind?: string;
  message?: string;
  receipt?: { ok: boolean; action?: string; code?: string; message?: string };
  undo?: { id: string };
}

function readConversation(): Conversation {
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const raw = fileArg ? readFileSync(fileArg, "utf8") : readFileSync(0, "utf8");
  const parsed = JSON.parse(raw) as Conversation;
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error("conversation needs a non-empty `steps` array");
  }
  return parsed;
}

function summarizeResult(r: TurnResult): string {
  if (r.kind === "receipt" && r.receipt) {
    const rc = r.receipt;
    return `receipt ${rc.ok ? "OK" : "ERR"} ${rc.action ?? ""}${rc.ok ? "" : ` [${rc.code}] ${rc.message ?? ""}`}${r.undo ? ` (undo:${r.undo.id})` : ""}`;
  }
  if (r.kind === "clarify") return `clarify "${(r.message ?? "").slice(0, 140)}"`;
  if (r.kind === "preview") return "preview (awaiting confirm)";
  return r.kind ?? "unknown";
}

async function main(): Promise<void> {
  const convo = readConversation();

  const selection: ModelClientSelection = {
    llmProvider: (process.env.LLM_PROVIDER as ModelClientSelection["llmProvider"]) ?? "http",
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL,
    geminiModel: process.env.GEMINI_MODEL,
  };
  let modelClient: ModelClient;
  try {
    modelClient = selectModelClient(selection);
  } catch (err) {
    console.error(`Refusing to run: ${err instanceof Error ? err.message : String(err)} (set LLM_* via --env-file=.env.server)`);
    process.exit(2);
  }

  const keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3998,
    baseUrl: "https://example.com/ai-assistant",
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    sessionSecret: "repro-session-secret",
    sessionTtlMs: 2 * 60 * 60 * 1000,
    databasePath: ":memory:",
    llmProvider: selection.llmProvider,
    llmMode: "tool",
    llmBaseUrl: selection.llmBaseUrl,
    llmApiKey: selection.llmApiKey,
    llmModel: selection.llmModel,
    llmAgentic: true,
    llmToolSelect: false,
  };
  const store = createStore(":memory:", { encryptionKey: "repro-key" });
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const fake = createFakeWorkspace(convo.seed ?? {});
  // Force the production auth class so add-on-only platform restrictions fire.
  const client = convo.addon ? { ...fake.client, authClass: "addon" as const } : fake.client;

  const app = createApp({ config, store, parser, modelClient, clockifyForWorkspace: () => client });
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: "ADMIN",
    addonId: "addon-1",
  });
  const sessionRes = await request(app).get("/component/assistant").query({ auth_token: token });
  const setCookie = sessionRes.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";

  console.log(`# repro-chat — model=${selection.llmModel ?? selection.llmProvider} addon=${!!convo.addon} steps=${convo.steps.length}\n`);

  let lastUndoId: string | undefined;
  let turnNo = 0;
  for (const step of convo.steps) {
    turnNo += 1;
    if (typeof step === "object" && step.undoLast) {
      if (!lastUndoId) {
        console.log(`[${turnNo}] UNDO — no undoable creation in the last turn; skipping`);
        continue;
      }
      const res = await request(app).post(`/api/undo/${lastUndoId}`).set("Cookie", cookie).send({});
      console.log(`[${turnNo}] UNDO ${lastUndoId} -> ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      lastUndoId = undefined;
      continue;
    }

    const message = step as string;
    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message });
    const reply = (res.body?.reply ?? {}) as { kind?: string; text?: string };
    const results = (res.body?.results ?? []) as TurnResult[];

    console.log(`[${turnNo}] USER: ${message}`);
    console.log(`     reply.kind = ${reply.kind ?? "?"}`);
    console.log(`     reply.text = ${JSON.stringify(reply.text ?? "")}`);
    for (const r of results) console.log(`     result     = ${summarizeResult(r)}`);

    // Duplication probe (issue 2): is a clarify/refusal text echoed BOTH as a
    // result message AND as reply.text in the same turn?
    const clarifyMsgs = results.filter((r) => r.kind === "clarify").map((r) => (r.message ?? "").trim());
    if (reply.text && clarifyMsgs.some((m) => m && m === reply.text!.trim())) {
      console.log(`     ⚠ DUP: reply.text duplicates a clarify result (renders twice in the UI)`);
    }

    const undo = results.find((r) => r.undo?.id)?.undo;
    lastUndoId = undo?.id;
    console.log("");
  }

  console.log("# done");
}

main().catch((err) => {
  console.error("REPRO FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
