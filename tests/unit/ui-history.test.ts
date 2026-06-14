import { describe, expect, it } from "vitest";
import { historyRestoreItems, reservedPendingFor, type HistoryResponse } from "../../src/ui/shared.js";

/**
 * Pure mapping from GET /api/chat/history to renderable restore items: bubbles
 * per non-empty content, results items per non-empty results, and the LIVE
 * pending previews LAST (so the actionable card sits at the bottom). Defensive
 * even against an older server: preview-kind results and undo handles in
 * stored messages are dropped client-side too.
 */
describe("historyRestoreItems", () => {
  it("maps an empty/absent history to no items", () => {
    expect(historyRestoreItems({})).toEqual([]);
    expect(historyRestoreItems({ ok: true, messages: [], pendingPreviews: [] })).toEqual([]);
  });

  it("is shape-safe: undefined/missing/empty input yields [] (never throws)", () => {
    // A fresh load or a transient non-OK GET resolves to `undefined` (json() only
    // throws on 401); historyRestoreItems must degrade to [] so the route can
    // skip the replay quietly instead of throwing an alarming red alert (plan 006).
    expect(historyRestoreItems(undefined as unknown as HistoryResponse)).toEqual([]);
    expect(historyRestoreItems({})).toEqual([]);
    expect(historyRestoreItems({ messages: [], pendingPreviews: [] })).toEqual([]);
  });

  it("emits bubbles for non-empty content and results items for non-empty results, in order", () => {
    const items = historyRestoreItems({
      ok: true,
      messages: [
        { role: "user", content: "create a tag urgent" },
        {
          role: "assistant",
          content: "Created it.",
          results: [{ kind: "receipt", receipt: { ok: true, action: "clockify_tags_create" } }],
        },
        { role: "assistant", content: "", results: [{ kind: "clarify", message: "Which one?" }] },
      ],
      pendingPreviews: [],
    });
    expect(items).toEqual([
      { kind: "bubble", role: "user", text: "create a tag urgent" },
      { kind: "bubble", role: "assistant", text: "Created it." },
      { kind: "results", results: [{ kind: "receipt", receipt: { ok: true, action: "clockify_tags_create" } }] },
      { kind: "results", results: [{ kind: "clarify", message: "Which one?" }] },
    ]);
  });

  it("drops preview-kind results and undo handles from stored messages (defense in depth)", () => {
    const items = historyRestoreItems({
      messages: [
        {
          role: "assistant",
          content: "x",
          results: [
            { kind: "preview", previewId: "p1", nonce: "n", preview: { actionLabel: "x", expectedChanges: [], reversibility: "", warnings: [] } },
            { kind: "receipt", receipt: { ok: true, action: "a" }, undo: { id: "u1" } },
          ],
        },
      ],
    });
    const resultsItem = items.find((i) => i.kind === "results");
    if (resultsItem?.kind !== "results") throw new Error("expected a results item");
    expect(resultsItem.results).toHaveLength(1);
    expect(resultsItem.results[0]).not.toHaveProperty("undo");
    expect(resultsItem.results[0].kind).toBe("receipt");
  });

  it("appends LIVE pending previews as the final item", () => {
    const preview = {
      kind: "preview" as const,
      previewId: "p1",
      nonce: "rotated",
      expiresAt: "2026-06-06T10:05:00.000Z",
      preview: { actionLabel: "Delete tag", expectedChanges: ["x"], reversibility: "", warnings: [] },
    };
    const items = historyRestoreItems({
      messages: [{ role: "user", content: "delete the tag" }],
      pendingPreviews: [preview],
    });
    expect(items.at(-1)).toEqual({ kind: "results", results: [preview] });
  });

  it("restores each live pending as its OWN card — never one merged Confirm-all batch", () => {
    // r1-new-session-restore-02: two pendings from UNRELATED turns must each
    // become a single-preview results item (one streaming Confirm each), not a
    // merged batch ("Confirm all applies only to the exact previewed batch").
    const p1 = {
      kind: "preview" as const,
      previewId: "p1",
      nonce: "n1",
      preview: { actionLabel: "Delete tag", expectedChanges: ["a"], reversibility: "", warnings: [] },
    };
    const p2 = {
      kind: "preview" as const,
      previewId: "p2",
      nonce: "n2",
      preview: { actionLabel: "Delete client", expectedChanges: ["b"], reversibility: "", warnings: [] },
    };
    const items = historyRestoreItems({
      messages: [{ role: "user", content: "do two unrelated things" }],
      pendingPreviews: [p1, p2],
    });
    const resultsItems = items.filter((i) => i.kind === "results");
    // One results item PER pending preview, in created-at order — never merged.
    expect(resultsItems).toEqual([
      { kind: "results", results: [p1] },
      { kind: "results", results: [p2] },
    ]);
  });

  it("ignores roles other than user/assistant and blank bubbles", () => {
    const items = historyRestoreItems({
      messages: [
        { role: "system", content: "internal" },
        { role: "assistant", content: "   " },
      ],
    });
    expect(items).toEqual([]);
  });
});

/**
 * r1-concurrency-races-02: the onStale re-arm path re-fetches history and pulls
 * the re-served LIVE pending (rotated nonce) for the stale tab's preview id.
 */
describe("reservedPendingFor (re-arm the stale tab from a fresh history fetch)", () => {
  const preview = (previewId: string, nonce: string) => ({
    kind: "preview" as const,
    previewId,
    nonce,
    preview: { actionLabel: "Delete tag", expectedChanges: ["x"], reversibility: "", warnings: [] },
  });

  it("returns the re-served pending (with its rotated nonce) for the matching id", () => {
    const history: HistoryResponse = { pendingPreviews: [preview("p1", "rotated-nonce")] };
    expect(reservedPendingFor(history, "p1")?.nonce).toBe("rotated-nonce");
  });

  it("returns undefined when the preview is no longer pending (another tab settled it)", () => {
    expect(reservedPendingFor({ pendingPreviews: [preview("p2", "n2")] }, "p1")).toBeUndefined();
    expect(reservedPendingFor({}, "p1")).toBeUndefined();
  });
});
