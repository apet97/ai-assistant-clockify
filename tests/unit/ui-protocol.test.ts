import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  decodeApiEnvelope,
  decodeChatResponse,
  decodeConfirmResponse,
  decodeHistoryResponse,
  decodeMeResponse,
  decodeNdjsonEvent,
  decodePermissionsResponse,
  decodeReceipt,
  decodeSessionsResponse,
  decodeUndoResponse,
  protocolErrorMessage,
} from "../../src/ui/protocol.js";

describe("UI runtime protocol contracts", () => {
  it("rejects a non-object JSON API body at the shared boundary", () => {
    expect(() => decodeApiEnvelope("unexpected html")).toThrow(ProtocolError);
    expect(() => decodeApiEnvelope({ message: "missing discriminant" })).toThrow(ProtocolError);
    expect(decodeApiEnvelope({ ok: false, message: "No session." })).toMatchObject({ ok: false });
  });

  it("decodes the exact persisted invoice PDF filename without inventing one from the artifact id", () => {
    const receipt = decodeReceipt({
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_invoices_export",
        data: {
          contentType: "application/pdf",
          artifact: {
            id: "artifact-1",
            downloadUrl: "/api/artifacts/artifact-1",
            filename: "clockify-invoice-INV-42.pdf",
            expiresAt: "2026-07-18T12:05:00.000Z",
          },
        },
      },
    });

    expect(receipt.receipt.artifact).toEqual({
      downloadUrl: "/api/artifacts/artifact-1",
      expiresAt: "2026-07-18T12:05:00.000Z",
      filename: "clockify-invoice-INV-42.pdf",
    });
  });

  it("rejects a successful invoice export without a complete PDF artifact descriptor", () => {
    for (const data of [
      undefined,
      { contentType: "text/html", artifact: {} },
      {
        contentType: "application/pdf",
        artifact: {
          id: "artifact-1",
          downloadUrl: "/api/artifacts/artifact-1",
          expiresAt: "2026-07-18T12:05:00.000Z",
        },
      },
    ]) {
      expect(() => decodeReceipt({
        kind: "receipt",
        receipt: { ok: true, action: "clockify_invoices_export", ...(data === undefined ? {} : { data }) },
      })).toThrow(ProtocolError);
    }
  });

  it("rejects malformed NDJSON as a visible protocol error instead of ignoring it", () => {
    expect(() => decodeNdjsonEvent({ type: "reply", text: 42 })).toThrow(ProtocolError);
    try {
      decodeNdjsonEvent({ type: "reply", text: 42 });
    } catch (error) {
      expect(protocolErrorMessage(error)).toBe("The assistant sent an invalid response. Please try again.");
    }
  });

  it("rejects an unknown NDJSON discriminant instead of silently dropping the event", () => {
    expect(() => decodeNdjsonEvent({ type: "some_future_event", payload: 1 })).toThrow(ProtocolError);
  });

  it("fully decodes preview and partial result payloads instead of trusting their discriminant", () => {
    expect(() => decodeNdjsonEvent({
      type: "result",
      result: {
        kind: "preview",
        previewId: "preview-1",
        nonce: "nonce-1",
        preview: {
          actionLabel: "Update project",
          expectedChanges: "not-an-array",
          reversibility: "Preview only",
          warnings: [],
        },
      },
    })).toThrow(ProtocolError);
    expect(() => decodeNdjsonEvent({ type: "result" })).toThrow(ProtocolError);
    expect(() => decodeNdjsonEvent({
      type: "result",
      result: {
        kind: "partial",
        receipt: { ok: true, action: "clockify_test" },
        message: "Stopped after one step.",
        recovery: { hint: 42 },
      },
    })).toThrow(ProtocolError);
  });

  it("preserves a validated undo handle on streamed confirmation receipts", () => {
    expect(decodeNdjsonEvent({
      type: "receipt",
      receipt: { ok: true, action: "clockify_tags_create" },
      undo: { id: "undo-1" },
    })).toMatchObject({ type: "receipt", undo: { id: "undo-1" } });
    expect(() => decodeNdjsonEvent({
      type: "receipt",
      receipt: { ok: true, action: "clockify_tags_create" },
      undo: {},
    })).toThrow(ProtocolError);
  });

  it("preserves the shared persistence-degradation flag on result and receipt events", () => {
    expect(decodeNdjsonEvent({
      type: "result",
      result: { kind: "clarify", message: "Which project?" },
      persistenceDegraded: true,
    })).toMatchObject({ type: "result", persistenceDegraded: true });
    expect(decodeNdjsonEvent({
      type: "receipt",
      receipt: { ok: true, action: "clockify_tags_create" },
      persistenceDegraded: true,
    })).toMatchObject({ type: "receipt", persistenceDegraded: true });
  });

  it("rejects a malformed persistence-degradation flag on every event that carries it", () => {
    expect(() => decodeNdjsonEvent({
      type: "result",
      result: { kind: "clarify", message: "Which project?" },
      persistenceDegraded: "yes",
    })).toThrow(ProtocolError);
    expect(() => decodeNdjsonEvent({
      type: "receipt",
      receipt: { ok: true, action: "clockify_tags_create" },
      persistenceDegraded: "yes",
    })).toThrow(ProtocolError);
  });

  it("validates and preserves persistence degradation on JSON confirmation responses", () => {
    expect(decodeConfirmResponse({
      ok: true,
      receipt: { ok: true, action: "clockify_tags_create" },
      persistenceDegraded: true,
    })).toMatchObject({ ok: true, persistenceDegraded: true });
    expect(() => decodeConfirmResponse({
      ok: true,
      receipt: { ok: true, action: "clockify_tags_create" },
      persistenceDegraded: "yes",
    })).toThrow(ProtocolError);
  });

  it("rejects a cross-origin artifact URL", () => {
    expect(() => decodeReceipt({
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_invoices_export",
        data: { contentType: "application/pdf", artifact: { downloadUrl: "https://example.test/invoice.pdf" } },
      },
    })).toThrow(/downloadUrl/);
  });

  it("decodes /api/me preferences and rejects missing or unsafe public links", () => {
    const valid = {
      ok: true,
      workspaceId: "workspace-1",
      adminUserId: "admin-1",
      workspaceRole: "ADMIN",
      csrfToken: "csrf-token",
      preferences: { theme: "dark", language: "sr", timeZone: "Europe/Belgrade" },
      links: {
        privacy: "https://assistant.example/privacy",
        support: "https://assistant.example/support",
        security: "https://assistant.example/security",
      },
    };
    expect(decodeMeResponse(valid)).toMatchObject({ preferences: { theme: "dark", language: "sr" } });
    expect(() => decodeMeResponse({ ...valid, links: { ...valid.links, support: "javascript:alert(1)" } })).toThrow(
      /links\.support/,
    );
    expect(() => decodeMeResponse({ ok: true, csrfToken: "csrf-token" })).toThrow(ProtocolError);
  });

  it("fully decodes permissions, history, and sessions instead of trusting ok:true", () => {
    const policy = { version: 2, groups: { reports: "read", invoices: "off" } };
    expect(decodePermissionsResponse({ ok: true, policy, firstRun: false, featureGroups: ["reports", "invoices"] }))
      .toMatchObject({ policy, firstRun: false });
    expect(() => decodePermissionsResponse({ ok: true, firstRun: false })).toThrow(ProtocolError);
    expect(() => decodePermissionsResponse({ ok: true, policy: { version: 2, groups: { reports: "owner" } }, firstRun: false }))
      .toThrow(ProtocolError);

    const history = decodeHistoryResponse({
      ok: true,
      messages: [{ role: "assistant", content: "Done", results: [{ kind: "receipt", receipt: { ok: true, action: "clockify_tags_list" } }] }],
      pendingPreviews: [],
    });
    expect(history.ok && history.messages).toHaveLength(1);
    expect(() => decodeHistoryResponse({ ok: true, messages: [{ role: "assistant", content: 42 }], pendingPreviews: [] }))
      .toThrow(ProtocolError);

    const sessions = decodeSessionsResponse({
      ok: true,
      sessions: [{ id: "s1", title: "First", messageCount: 2, lastMessageAt: "2026-07-18T12:00:00.000Z", createdAt: "2026-07-18T11:00:00.000Z", current: true }],
    });
    expect(sessions.ok && sessions.sessions[0]?.current).toBe(true);
    expect(() => decodeSessionsResponse({ ok: true, sessions: [{ id: "s1", title: "First", messageCount: "2" }] }))
      .toThrow(ProtocolError);
  });

  it("fully decodes chat, confirmation, and undo success payloads", () => {
    const chat = decodeChatResponse({
      ok: true,
      reply: { kind: "answer", text: "Here you go." },
      results: [{ kind: "clarify", message: "Which project?" }],
    });
    expect(chat.ok && chat.results[0]?.kind).toBe("clarify");
    expect(() => decodeChatResponse({ ok: true, reply: { kind: "answer" }, results: [] })).toThrow(ProtocolError);

    expect(decodeConfirmResponse({
      ok: true,
      receipt: { ok: true, action: "clockify_tags_create" },
      resume: { reply: { kind: "answer", text: "Created." }, results: [] },
    })).toMatchObject({ ok: true, receipt: { action: "clockify_tags_create" } });
    expect(() => decodeConfirmResponse({ ok: true })).toThrow(ProtocolError);
    expect(decodeConfirmResponse({ ok: false, code: "expired", message: "Expired." })).toEqual({
      ok: false,
      code: "expired",
      message: "Expired.",
    });

    expect(decodeUndoResponse({ ok: true, receipt: { ok: true, action: "undo" } })).toMatchObject({ ok: true });
    expect(() => decodeUndoResponse({ ok: true, receipt: { ok: "yes", action: "undo" } })).toThrow(ProtocolError);
  });
});
