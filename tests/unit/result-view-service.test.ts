import { describe, expect, it } from "vitest";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { requireCompletePresenterCoverage } from "../../src/assistant-v2/presentation/presenter-registry.js";
import { decodePresentedResultEnvelope } from "../../src/assistant-v2/presentation/presented-result.js";
import { chatReceiptFromEnvelope, createResultViewService, factsFromReceipt } from "../../src/services/result-view-service.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";

/**
 * Closure-plan PR 3 (F05): the one action-result → envelope boundary. Status,
 * title, and facts are SERVER-derived from canonical rows and reviewed catalog
 * metadata; malformed shapes fail closed; provider prose contributes only the
 * sanitized summary.
 */

const service = createResultViewService({ registry: MODEL_API_ACTION_CATALOG });

describe("result view service", () => {
  it("every api-exposed catalog action has exactly one registered presenter (startup-validated coverage)", () => {
    const actions = MODEL_API_ACTION_CATALOG.actions;
    expect(actions.length).toBeGreaterThan(100);
    expect(() => requireCompletePresenterCoverage(actions)).not.toThrow();
  });

  it("presents a successful read with a HUMAN title and server-derived facts", () => {
    const envelope = service.presentActionResult("clockify_entries_list", "result-1", {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_entries_list",
        message: "Found one entry.",
        data: { rows: [{ id: "e1" }], truncated: true },
      },
    });
    expect(() => decodePresentedResultEnvelope(envelope)).not.toThrow();
    expect(envelope.presentation.status).toBe("succeeded");
    // Reviewed catalog description, not the raw action name.
    expect(envelope.presentation.title).not.toBe("clockify_entries_list");
    expect(envelope.presentation.title.length).toBeGreaterThan(0);
    expect(envelope.presentation.summary).toBe("Found one entry.");
    expect(envelope.presentation.facts).toContainEqual({ label: "rows returned", value: "1" });
    expect(envelope.presentation.facts).toContainEqual({ label: "Complete", value: "no — the list was truncated" });
    expect(envelope.actionResultId).toBe("result-1");
    expect(envelope.diagnostic?.kind).toBe("sanitized_receipt");
  });

  it("presents a failed receipt as FAILED with the bounded code", () => {
    const envelope = service.presentActionResult("clockify_entries_list", "result-2", {
      kind: "receipt",
      receipt: { ok: false, action: "clockify_entries_list", code: "policy_denied", message: "Denied." },
    });
    expect(envelope.presentation.status).toBe("failed");
    expect(envelope.presentation.warnings[0]).toEqual({
      code: "policy_denied",
      message: "The action did not complete.",
    });
  });

  it("FAILS CLOSED on an unrecognized stored shape — never fabricated success", () => {
    for (const malformed of [null, 42, "text", [], { kind: "mystery" }, { unexpected: true }]) {
      const envelope = service.presentActionResult("clockify_entries_list", "result-3", malformed);
      expect(envelope.presentation.status).toBe("failed");
      expect(envelope.presentation.warnings).toContainEqual({
        code: "unrecognized_result_shape",
        message: "The stored result could not be interpreted.",
      });
    }
  });

  it("presents a stored clarify result as failed-with-question, never success", () => {
    const envelope = service.presentActionResult("clockify_entries_list", "result-4", {
      kind: "clarify",
      message: "Which Alice?",
    });
    expect(envelope.presentation.status).toBe("failed");
    expect(envelope.presentation.summary).toBe("Which Alice?");
    expect(envelope.presentation.warnings[0]!.code).toBe("clarification_required");
  });

  it("presents the no-op stop-timer receipt as NO CHANGE NEEDED, never a plain success (readiness A5 / D-3)", () => {
    // The EXACT receipt src/harness/workflows/time-tracking.ts returns when
    // there is no running timer: ok:true + a warning, no `data`, no `changed`
    // (`successReceipt` omits empty change buckets by construction).
    const envelope = service.presentActionResult("clockify_stop_timer", "result-noop", {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_stop_timer",
        warnings: [{ message: "No running timer to stop." }],
      },
    });
    expect(() => decodePresentedResultEnvelope(envelope)).not.toThrow();
    expect(envelope.presentation.status).toBe("no_change_needed");
    expect(envelope.presentation.warnings).toContainEqual(
      expect.objectContaining({ message: "No running timer to stop." }),
    );
  });

  it("a warnings-only success WITH data (a read) stays succeeded — never reclassified as a no-op", () => {
    // The clockify_period_report / reports shape: ok + warning + data payload.
    const envelope = service.presentActionResult("clockify_reports_summary", "result-report", {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_reports_summary",
        data: { totalSeconds: 0 },
        warnings: [{ code: "report_truncated", message: "The report was truncated." }],
      },
    });
    expect(envelope.presentation.status).toBe("succeeded");
  });

  it("a success with a non-empty changed bucket stays succeeded", () => {
    const envelope = service.presentActionResult("clockify_tags_create", "result-created", {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_tags_create",
        changed: { created: [{ type: "tag", id: "t1", name: "urgent" }] },
      },
    });
    expect(envelope.presentation.status).toBe("succeeded");
  });

  it("chatReceiptFromEnvelope classifies no_change_needed as ok:true and preserves the status", () => {
    const envelope = service.presentActionResult("clockify_stop_timer", "result-noop-2", {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_stop_timer",
        warnings: [{ message: "No running timer to stop." }],
      },
    });
    const chatReceipt = chatReceiptFromEnvelope(envelope) as {
      receipt: { ok: boolean; presentedStatus: string };
    };
    expect(chatReceipt.receipt.ok).toBe(true);
    expect(chatReceipt.receipt.presentedStatus).toBe("no_change_needed");
  });

  it("derives change facts from a safe-write receipt", () => {
    const facts = factsFromReceipt({
      ok: true,
      changed: { created: [{ type: "tag", id: "t1", name: "urgent" }] },
    });
    expect(facts).toContainEqual({ label: "Created", value: "tag “urgent”" });
  });

  it("omits an oversized diagnostic instead of truncating it", () => {
    const envelope = service.presentActionResult("clockify_entries_list", "result-5", {
      kind: "receipt",
      receipt: { ok: true, action: "clockify_entries_list", message: "big", data: { blob: "x".repeat(30_000) } },
    });
    expect(envelope.diagnostic).toBeUndefined();
    expect(envelope.presentation.status).toBe("succeeded");
  });

  it("presents a pending confirmation from the stored preview with target facts", () => {
    const created = createPendingConfirmation({
      id: "conf-1",
      sessionId: "session-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: ["high_risk_write"],
      preview: {
        actionLabel: "Create project",
        featureGroup: "work_structure",
        riskLabels: ["high_risk_write"],
        targets: [{ type: "project", id: "p-1", name: "Apollo" }],
        expectedChanges: ["Create project Apollo"],
        warnings: ["Name already similar to an archived project"],
      },
      operation: {
        operationId: "op-1",
        actionName: "clockify_projects_create",
        payload: { name: "Apollo" },
      },
      installationGeneration: 1,
      sessionSecret: "test-session-secret",
      now: new Date("2026-07-26T00:00:00.000Z"),
      ttlMs: 300_000,
      origin: "assistant",
      registryId: "v2-api",
      authorityModel: "preview_confirmation_v2",
      executorKind: "risky_commit",
      runId: "run-1",
    });
    const presentation = service.presentPendingConfirmation(created.record);
    expect(presentation.status).toBe("pending_confirmation");
    expect(presentation.title).toBe("Create project");
    expect(presentation.summary).toBe("Create project Apollo");
    expect(presentation.facts).toContainEqual({ label: "Target project", value: "Apollo" });
    expect(presentation.warnings[0]!.message).toContain("archived");
    // Descriptive content only — the caller attaches the live control.
    expect(JSON.stringify(presentation)).not.toMatch(/nonce/i);
  });
});
