import { describe, expect, it } from "vitest";
import { historyRestoreItems, type HistoryResponse } from "../../src/ui/shared.js";

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
