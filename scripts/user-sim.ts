/**
 * THROWAWAY user-simulation driver (delete after the run). Drives a multi-turn
 * chat through the REAL Express route with the LIVE model (LLM_* from
 * .env.server) against an in-memory fake workspace — and CONFIRMS every pending
 * preview (a real user clicking "Confirm"), following resumes that chain more
 * previews. Reports the LIVE model token usage for the whole session.
 *
 * Conversation JSON on stdin or a file arg: { "addon"?, "seed"?, "steps": ["msg", ...] }.
 *   echo '{"steps":["log 2h on Apollo today"]}' | npx tsx --env-file=.env.server scripts/user-sim.ts
 */
import { readFileSync } from "node:fs";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { createApp } from "../src/server.js";
import { createSignatureParser } from "../src/addon/verify.js";
import { createStore } from "../src/db/store.js";
import type { AppConfig } from "../src/config.js";
import { selectModelClient, type ModelClientSelection } from "../src/assistant/select-model-client.js";
import { trackUsage } from "../src/assistant/usage.js";
import type { ModelClient } from "../src/assistant/model-client.js";
import { createFakeWorkspace } from "../tests/helpers/fake-clockify.js";

const ADDON_KEY = "ai-assistant";

interface Convo { addon?: boolean; seed?: Record<string, unknown>; steps: string[] }
interface ResultItem { kind?: string; previewId?: string; nonce?: string; receipt?: { ok: boolean; action?: string; code?: string } }

// A realistic default workspace so a persona's requests have things to act on.
const DEFAULT_SEED = {
  clients: [{ id: "c1", name: "Acme Corp" }, { id: "c2", name: "Globex" }],
  projects: [{ id: "p1", name: "Website Redesign", clientId: "c1" }, { id: "p2", name: "Mobile App", clientId: "c2" }],
  tasks: [{ id: "k1", name: "Design", projectId: "p1" }, { id: "k2", name: "Build", projectId: "p1" }],
  tags: [{ id: "t1", name: "Billable" }, { id: "t2", name: "Internal" }],
  users: [
    { id: "admin-1", name: "Alex Admin", email: "alex@x.com", status: "ACTIVE" },
    { id: "u2", name: "Sam Dev", email: "sam@x.com", status: "ACTIVE" },
  ],
  groups: [{ id: "g1", name: "Engineering", userIds: ["u2"] }],
  invoices: [{ id: "inv1", number: "INV-1001", clientId: "c1", currency: "USD", status: "UNSENT", items: [{ order: 0, description: "Discovery", quantity: 1, unitPrice: 50000, itemType: "Service" }] }],
};

function readConvo(): Convo {
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const raw = fileArg ? readFileSync(fileArg, "utf8") : readFileSync(0, "utf8");
  const parsed = JSON.parse(raw) as Convo;
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) throw new Error("need a non-empty steps[]");
  return parsed;
}

function summarize(r: ResultItem): string {
  if (r.kind === "receipt" && r.receipt) return `receipt ${r.receipt.ok ? "OK" : `ERR[${r.receipt.code}]`} ${r.receipt.action ?? ""}`;
  if (r.kind === "preview") return "preview";
  if (r.kind === "clarify") return "clarify";
  return r.kind ?? "?";
}

async function main(): Promise<void> {
  const convo = readConvo();
  const selection: ModelClientSelection = {
    llmProvider: (process.env.LLM_PROVIDER as ModelClientSelection["llmProvider"]) ?? "http",
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL,
    geminiModel: process.env.GEMINI_MODEL,
  };
  let baseClient: ModelClient;
  try { baseClient = selectModelClient(selection); }
  catch (err) { console.error(`Refusing: ${err instanceof Error ? err.message : err} (set LLM_* via --env-file=.env.server)`); process.exit(2); }
  const tracked = trackUsage(baseClient, () => new Date());

  const keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test", port: 3997, baseUrl: "https://example.com/ai-assistant",
    clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY,
    sessionSecret: "user-sim-secret", databasePath: ":memory:",
    llmProvider: selection.llmProvider, llmBaseUrl: selection.llmBaseUrl,
    llmApiKey: selection.llmApiKey, llmModel: selection.llmModel, llmAgentic: true,
  };
  const store = createStore(":memory:", { encryptionKey: "user-sim-key" });
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const fake = createFakeWorkspace(convo.seed ?? DEFAULT_SEED);
  const client = convo.addon ? { ...fake.client, authClass: "addon" as const } : fake.client;
  const app = createApp({ config, store, parser, modelClient: tracked.client, clockifyForWorkspace: () => client });
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: "ws-1", user: "admin-1", workspaceRole: "ADMIN", addonId: "addon-1" });
  const sessionRes = await request(app).get("/component/assistant").query({ auth_token: token });
  const setCookie = sessionRes.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";

  console.log(`# user-sim model=${selection.llmModel ?? selection.llmProvider} steps=${convo.steps.length}\n`);
  let confirmed = 0, anomalies = 0;

  // Confirm every pending preview, following resumes that chain more previews (cap rounds).
  async function confirmAll(results: ResultItem[]): Promise<void> {
    let pending = results.filter((r) => r.kind === "preview" && r.previewId && r.nonce);
    for (let round = 0; round < 6 && pending.length; round++) {
      const next: ResultItem[] = [];
      for (const p of pending) {
        const res = await request(app).post(`/api/confirmations/${p.previewId}/confirm`).set("Cookie", cookie).send({ nonce: p.nonce });
        const ok = res.body?.ok;
        const action = res.body?.receipt?.action ?? "";
        confirmed += 1;
        if (!ok) anomalies += 1;
        console.log(`     CONFIRM ${String(p.previewId).slice(0, 8)} -> ${ok ? "OK" : `ERR[${res.body?.receipt?.code ?? res.status}]`} ${action}`);
        for (const rr of (res.body?.resume?.results ?? []) as ResultItem[]) {
          console.log(`       resume = ${summarize(rr)}`);
          if (rr.kind === "preview" && rr.previewId && rr.nonce) next.push(rr);
        }
      }
      pending = next;
    }
  }

  let turn = 0;
  for (const message of convo.steps) {
    turn += 1;
    try {
      const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message });
      const reply = (res.body?.reply ?? {}) as { kind?: string; text?: string };
      const results = (res.body?.results ?? []) as ResultItem[];
      console.log(`[${turn}] USER: ${message}`);
      console.log(`     reply.kind=${reply.kind ?? "?"}  text=${JSON.stringify((reply.text ?? "").slice(0, 160))}`);
      for (const r of results) console.log(`     result = ${summarize(r)}`);
      if (res.status !== 200) { anomalies += 1; console.log(`     ⚠ HTTP ${res.status}`); }
      await confirmAll(results);
    } catch (err) {
      anomalies += 1;
      console.log(`[${turn}] ⚠ TURN ERROR: ${err instanceof Error ? err.message : err}`);
    }
    console.log("");
  }

  const u = tracked.usage;
  console.log(`# TOKENS prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.promptTokens + u.completionTokens} modelCalls=${u.modelCalls} reported=${u.usageReported}`);
  console.log(`# CONFIRMED ${confirmed} preview(s) | ANOMALIES ${anomalies} | STATUS ${anomalies ? "ANOMALIES" : "ok"}`);
}

main().catch((err) => { console.error("USER-SIM FAILED:", err instanceof Error ? err.stack : err); process.exit(1); });
