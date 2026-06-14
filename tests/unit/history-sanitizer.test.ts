import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HISTORY_RESULT_MAX_BYTES,
  claimsCompletedMutation,
  previewReplyText,
  pruneHistoryResult,
  sanitizeStoredReplyForModel,
} from "../../src/routes/history-sanitizer.js";

/**
 * Live item 318: a long session saturated with the deterministic
 * truthful-preview reply ("Review the change below…") taught the model to
 * REPRODUCE that boilerplate as its own answer with zero tool calls. The
 * stored history keeps the exact text (it's what the admin saw); only the
 * model-visible copy is rewritten into a neutral factual note.
 *
 * safety-invariants-02: assert against `previewReplyText` (the single source of
 * truth) rather than a re-typed literal, so a reword can't silently desync the
 * stored boilerplate from the sanitizer regex.
 */
describe("sanitizeStoredReplyForModel", () => {
  it("rewrites the single-preview boilerplate into a neutral factual note", () => {
    const out = sanitizeStoredReplyForModel(previewReplyText(1));
    expect(out).not.toBe(previewReplyText(1));
    expect(out).not.toContain('click "Confirm"');
    expect(out).not.toContain("Review the change below");
    expect(out).toContain("button confirmation");
  });

  it("rewrites the batch-preview boilerplate too", () => {
    const out = sanitizeStoredReplyForModel(previewReplyText(3));
    expect(out).not.toBe(previewReplyText(3));
    expect(out).not.toContain('click "Confirm all"');
    expect(out).toContain("button confirmation");
  });

  it("keeps the route source free of NUL bytes (so grep/rg don't skip it as binary)", () => {
    // The COUNT_SENTINEL used \x00…\x00 — two literal NUL bytes that made grep, rg,
    // and `file` treat the most safety-critical source as BINARY and silently skip
    // it. The sentinel must stay printable; the plural-count match above proves the
    // swap still works.
    const src = readFileSync(new URL("../../src/routes/api.ts", import.meta.url), "utf8");
    expect(src.includes("\u0000")).toBe(false);
  });

  it("leaves ordinary assistant replies byte-identical", () => {
    const texts = [
      "Here are your projects: Alpha, Beta.",
      "Done — the tag was created.",
      "I couldn't find an active project named \"X\".",
    ];
    for (const text of texts) expect(sanitizeStoredReplyForModel(text)).toBe(text);
  });
});

/**
 * r2-new-session-restore-06: GET /api/chat/history caps replay by message COUNT
 * (50) but not by bytes — a long session with several large list/report turns
 * re-ships the union of all those read-action `data` blobs on every iframe
 * reload. pruneHistoryResult backstops the count cap: a fat read receipt's bulky
 * `data` is dropped with an honest note (mirroring capToolResultForModel),
 * keeping the human record (status/changed/warnings/message). The admin already
 * consumed the data live; restore re-anchors the conversation, not the megabytes.
 */
describe("pruneHistoryResult (byte backstop for session restore)", () => {
  it("drops a fat read receipt's `data` blob with an honest note, keeping the rest", () => {
    const bigItems = Array.from({ length: 5_000 }, (_, i) => ({
      id: `proj-${i}`,
      name: `Project number ${i} with a fairly long descriptive name`,
    }));
    const result = {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_projects_list",
        entity: "project",
        ids: { workspaceId: "ws-1" },
        data: { count: bigItems.length, items: bigItems },
        warnings: [{ code: "demo", message: "kept" }],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeGreaterThan(HISTORY_RESULT_MAX_BYTES);

    const pruned = pruneHistoryResult(result) as {
      kind: string;
      receipt: { ok: boolean; action: string; ids: unknown; warnings: unknown; data: { note?: string; items?: unknown } };
    };
    // The fat read payload is gone; an honest note replaces it.
    expect(pruned.receipt.data.items).toBeUndefined();
    expect(typeof pruned.receipt.data.note).toBe("string");
    // The human record survives.
    expect(pruned.kind).toBe("receipt");
    expect(pruned.receipt.ok).toBe(true);
    expect(pruned.receipt.action).toBe("clockify_projects_list");
    expect(pruned.receipt.ids).toEqual({ workspaceId: "ws-1" });
    expect(pruned.receipt.warnings).toEqual([{ code: "demo", message: "kept" }]);
    // And the pruned result now fits the byte budget.
    expect(Buffer.byteLength(JSON.stringify(pruned), "utf8")).toBeLessThanOrEqual(HISTORY_RESULT_MAX_BYTES);
  });

  it("leaves a small receipt byte-identical (no note injected)", () => {
    const result = {
      kind: "receipt",
      receipt: { ok: true, action: "clockify_status", data: { running: false } },
    };
    expect(pruneHistoryResult(result)).toEqual(result);
  });

  it("leaves a non-receipt result untouched", () => {
    const clarify = { kind: "clarify", message: "Which project?", options: [{ label: "A", value: "a" }] };
    expect(pruneHistoryResult(clarify)).toEqual(clarify);
  });
});

/**
 * F10-truthfulness-assistant-falsely-claims-a-t: a plain-answer turn that ran
 * ZERO tool calls cannot have mutated anything (risky writes only land via the
 * preview→button-confirm flow; a safe write leaves a receipt). The route uses
 * this predicate — gated on a no-results turn — to refuse to relay a fabricated
 * completion claim. It must match completed-mutation framing yet leave future /
 * conditional offers and pure read answers untouched.
 */
describe("claimsCompletedMutation (truthfulness guard predicate)", () => {
  it("matches a fabricated completion claim", () => {
    const claims = [
      "Done! The tag **AIASSIST_SMOKE_tour** has been renamed to **AIASSIST_SMOKE_tour_renamed**.",
      "I've deleted the urgent tag and created a new one called done.",
      "The project was archived.",
      "Successfully updated the client.",
      "I created the invoice for qwen.",
      "All set — the tag was removed.",
      "I've logged 2 hours on Acme for today.",
      "The role has been granted.",
    ];
    for (const text of claims) expect(claimsCompletedMutation(text)).toBe(true);
  });

  it("does NOT match a future / conditional offer or a read-only answer", () => {
    const safe = [
      "I can rename tags for you — which tag would you like to rename, and to what?",
      "Would you like me to delete the urgent tag?",
      "I'll create the invoice once you confirm the amount.",
      "Should I update the client's address?",
      "Here are your tags: urgent, stale, done.",
      "I found 3 clients matching that name.",
      "Could you say more about what you'd like changed?",
      "I couldn't find an active project named \"X\".",
    ];
    for (const text of safe) expect(claimsCompletedMutation(text)).toBe(false);
  });
});
