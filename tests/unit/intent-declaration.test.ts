import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DECLARE_INTENT_TOOL_NAME,
  declareIntentCapability,
  filterCatalogByIntentCapability,
} from "../../src/assistant/intent-declaration.js";
import type { ModelClient, ModelMessage, ToolDefinition } from "../../src/assistant/model-client.js";
import type { ActionCatalogEntry } from "../../src/harness/action.js";

const catalogHash = createHash("sha256").update("test-catalog").digest("hex");
const writeActionNames = ["clockify_project_update", "clockify_invoice_create"] as const;

function byteSpan(authoredText: string, literal: string): { startByte: number; endByte: number; text: string } {
  const characterStart = authoredText.indexOf(literal);
  if (characterStart < 0) throw new Error(`Missing test literal: ${literal}`);
  const startByte = Buffer.byteLength(authoredText.slice(0, characterStart), "utf8");
  return { startByte, endByte: startByte + Buffer.byteLength(literal, "utf8"), text: literal };
}

function nativeModel(
  args: Record<string, unknown>,
  capture?: { messages?: ModelMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal },
): ModelClient {
  return {
    complete: vi.fn(async () => {
      throw new Error("JSON fallback must not run for a native client");
    }),
    completeWithTools: vi.fn(async (messages, tools, signal) => {
      if (capture) Object.assign(capture, { messages, tools, signal });
      return {
        text: "",
        toolCalls: [{ id: "declare-1", name: DECLARE_INTENT_TOOL_NAME, arguments: args }],
      };
    }),
  };
}

function declaration(actionName: string, sourceSpan: { startByte: number; endByte: number; text: string }) {
  return {
    writeActions: [{
      actionName,
      sourceSpans: [sourceSpan],
      literalConstraints: [{ path: "name", value: sourceSpan.text, sourceSpan }],
      maxExecutions: 1,
    }],
  };
}

describe("declareIntentCapability", () => {
  it("grounds one structured JSON constraint from an exact authored span", async () => {
    const currentText = 'Create an invoice with items [{"description":"Audit","quantity":2}]';
    const span = byteSpan(currentText, '[{"description":"Audit","quantity":2}]');
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_invoice_create",
          sourceSpans: [span],
          literalConstraints: [{
            path: "items",
            value: [{ description: "Audit", quantity: 2 }],
            sourceSpan: span,
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames,
      catalogHash,
    });

    expect(capability).toMatchObject({
      version: 1,
      mode: "allow",
      writeActions: [{ literalConstraints: [{ value: [{ description: "Audit", quantity: 2 }] }] }],
    });
  });

  it("accepts one native declaration and produces an immutable allow capability", async () => {
    const currentText = "Rename the project to Atlas.";
    const span = byteSpan(currentText, "Atlas");

    const capability = await declareIntentCapability({
      modelClient: nativeModel(declaration("clockify_project_update", span)),
      currentText,
      writeActionNames,
      catalogHash,
    });

    expect(capability).toEqual({
      version: 1,
      mode: "allow",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      catalogHash,
      writeActions: [{
        actionName: "clockify_project_update",
        sourceSpans: [span],
        literalConstraints: [{ path: "name", value: "Atlas", sourceSpan: span }],
        maxExecutions: 1,
      }],
    });
  });

  it("uses UTF-8 byte offsets and validates Serbian Latin, diacritics, and Cyrillic exactly", async () => {
    const currentText = "Preimenuj projekat u Žetva za тим Београд.";
    const span = byteSpan(currentText, "Žetva");
    const cyrillicSpan = byteSpan(currentText, "Београд");
    const actionSpan = byteSpan(currentText, "Preimenuj");
    const payload = {
      writeActions: [{
        actionName: "clockify_project_update",
        sourceSpans: [actionSpan, span, cyrillicSpan],
        literalConstraints: [
          { path: "name", value: "Žetva", sourceSpan: span },
          { path: "team", value: "Београд", sourceSpan: cyrillicSpan },
        ],
        maxExecutions: 1,
      }],
    };

    const capability = await declareIntentCapability({
      modelClient: nativeModel(payload),
      currentText,
      writeActionNames,
      catalogHash,
    });

    expect(cyrillicSpan.startByte).toBeGreaterThan(currentText.indexOf("Београд"));
    expect(capability.mode).toBe("allow");
    expect(capability.writeActions[0]?.literalConstraints[0]?.sourceSpan).toEqual(span);
    expect(capability.writeActions[0]?.literalConstraints[1]?.sourceSpan).toEqual(cyrillicSpan);
  });

  it("sends only current and unresolved prior admin-authored segments plus the allowlist/hash", async () => {
    const capture: { messages?: ModelMessage[]; tools?: ToolDefinition[] } = {};
    const unresolvedPriorText = "Which project? Atlas or Vega?";
    const currentText = "Atlas, and rename it to Žetva.";
    const canonicalText = `${unresolvedPriorText}\n${currentText}`;
    const span = byteSpan(canonicalText, "Žetva");

    await declareIntentCapability({
      modelClient: nativeModel(declaration("clockify_project_update", span), capture),
      currentText,
      unresolvedPriorText,
      writeActionNames,
      catalogHash,
    });

    expect(capture.messages).toHaveLength(2);
    expect(capture.messages?.map((message) => message.role)).toEqual(["system", "user"]);
    const payload = JSON.parse(capture.messages?.[1]?.content ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({
      version: 1,
      offsetEncoding: "utf8-bytes",
      catalogHash,
      writeActionNames: [...writeActionNames],
      segments: [
        {
          source: "unresolved_prior",
          startByte: 0,
          endByte: Buffer.byteLength(unresolvedPriorText, "utf8"),
          text: unresolvedPriorText,
        },
        {
          source: "current",
          startByte: Buffer.byteLength(`${unresolvedPriorText}\n`, "utf8"),
          endByte: Buffer.byteLength(canonicalText, "utf8"),
          text: currentText,
        },
      ],
    });
    expect(capture.messages?.map((message) => message.content).join("\n")).not.toContain("Clockify result");
    expect(capture.tools).toHaveLength(1);
    expect(capture.tools?.[0]?.name).toBe(DECLARE_INTENT_TOOL_NAME);
    expect(capture.tools?.[0]?.parameters).toMatchObject({ additionalProperties: false });
  });

  it("uses one strict JSON fallback call with the same validation and no repair", async () => {
    const currentText = "Create invoice for 125.50.";
    const span = byteSpan(currentText, "125.50");
    const complete = vi.fn(async () => JSON.stringify({
      writeActions: [{
        actionName: "clockify_invoice_create",
        sourceSpans: [byteSpan(currentText, "Create invoice"), span],
        literalConstraints: [{ path: "amount", value: 125.5, sourceSpan: span }],
        maxExecutions: 1,
      }],
    }));

    const capability = await declareIntentCapability({
      modelClient: { complete },
      currentText,
      writeActionNames,
      catalogHash,
    });

    expect(capability.mode).toBe("allow");
    expect(capability.writeActions[0]?.literalConstraints[0]?.value).toBe(125.5);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("passes the exact AbortSignal through native and JSON provider calls", async () => {
    const controller = new AbortController();
    const nativeCapture: { signal?: AbortSignal } = {};
    const currentText = "Rename to Atlas";
    const payload = declaration("clockify_project_update", byteSpan(currentText, "Atlas"));
    const jsonSignal: { value?: AbortSignal } = {};
    const jsonModel: ModelClient = {
      complete: vi.fn(async (_messages, _usage, signal) => {
        jsonSignal.value = signal;
        return JSON.stringify(payload);
      }),
    };

    await declareIntentCapability({
      modelClient: nativeModel(payload, nativeCapture),
      currentText,
      writeActionNames,
      catalogHash,
      signal: controller.signal,
    });
    await declareIntentCapability({
      modelClient: jsonModel,
      currentText,
      writeActionNames,
      catalogHash,
      signal: controller.signal,
    });

    expect(nativeCapture.signal).toBe(controller.signal);
    expect(jsonSignal.value).toBe(controller.signal);
  });

  it.each([
    ["provider failure", async () => { throw new Error("provider unavailable"); }],
    ["malformed JSON", async () => "{not-json"],
    ["invented action", async () => JSON.stringify(declaration("clockify_users_delete", { startByte: 0, endByte: 6, text: "Rename" }))],
    ["invented literal", async () => JSON.stringify(declaration("clockify_project_update", { startByte: 0, endByte: 6, text: "Vega" }))],
  ])("persists a deny-all-writes-shaped result after %s", async (_label, complete) => {
    const capability = await declareIntentCapability({
      modelClient: { complete },
      currentText: "Rename the project to Atlas.",
      writeActionNames,
      catalogHash,
    });

    expect(capability).toMatchObject({
      version: 1,
      mode: "deny_all_writes",
      catalogHash,
      writeActions: [],
    });
  });

  it.each([
    ["inside a UTF-8 code point", { startByte: 1, endByte: 3, text: "Ž" }],
    ["outside the request", { startByte: 0, endByte: 999, text: "Ž" }],
    ["across authored segments", { startByte: 2, endByte: 5, text: "o\nБ" }],
  ])("denies malformed source spans: %s", async (_label, sourceSpan) => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel(declaration("clockify_project_update", sourceSpan)),
      unresolvedPriorText: "Žao",
      currentText: "Бео",
      writeActionNames,
      catalogHash,
    });

    expect(capability.mode).toBe("deny_all_writes");
  });

  it("denies zero/multiple/wrong native declaration calls without falling back or retrying", async () => {
    const complete = vi.fn(async () => "must not run");
    const outputs = [
      { text: "", toolCalls: [] },
      {
        text: "",
        toolCalls: [
          { id: "1", name: DECLARE_INTENT_TOOL_NAME, arguments: { writeActions: [] } },
          { id: "2", name: DECLARE_INTENT_TOOL_NAME, arguments: { writeActions: [] } },
        ],
      },
      { text: "", toolCalls: [{ id: "1", name: "some_other_tool", arguments: { writeActions: [] } }] },
    ];

    for (const output of outputs) {
      const completeWithTools = vi.fn(async () => output);
      const capability = await declareIntentCapability({
        modelClient: { complete, completeWithTools },
        currentText: "Rename to Atlas",
        writeActionNames,
        catalogHash,
      });
      expect(capability.mode).toBe("deny_all_writes");
      expect(completeWithTools).toHaveBeenCalledTimes(1);
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps every read while preventing a full-catalog fallback from reintroducing undeclared writes", async () => {
    const entries: ActionCatalogEntry[] = [
      { name: "clockify_status", description: "Read", featureGroup: "workspace_settings", risks: ["read"], args: "{}" },
      { name: "clockify_project_update", description: "Write", featureGroup: "work_structure", risks: ["high_risk_write"], args: "{}" },
      { name: "clockify_invoice_create", description: "Write", featureGroup: "invoices", risks: ["billing"], args: "{}" },
    ];
    const currentText = "Rename to Atlas";
    const allow = await declareIntentCapability({
      modelClient: nativeModel(declaration("clockify_project_update", byteSpan(currentText, "Atlas"))),
      currentText,
      writeActionNames,
      catalogHash,
    });
    const deny = await declareIntentCapability({
      modelClient: { complete: vi.fn(async () => "bad") },
      currentText,
      writeActionNames,
      catalogHash,
    });

    expect(filterCatalogByIntentCapability(entries, allow).map((entry) => entry.name)).toEqual([
      "clockify_status",
      "clockify_project_update",
    ]);
    expect(filterCatalogByIntentCapability(entries, deny).map((entry) => entry.name)).toEqual([
      "clockify_status",
    ]);
  });
});
