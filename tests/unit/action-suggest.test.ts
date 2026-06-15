import { describe, expect, it } from "vitest";
import { nearestNames } from "../../src/harness/action-suggest.js";
import { suggestActionNames } from "../../src/harness/catalog.js";
import { executeAction } from "../../src/harness/actions.js";
import type { ActionContext } from "../../src/harness/action.js";

const CANDIDATES = [
  "clockify_invoices_create",
  "clockify_start_timer",
  "clockify_stop_timer",
  "clockify_tags_delete",
  "clockify_status",
];

describe("nearestNames", () => {
  it("catches a plural/typo near-miss", () => {
    expect(nearestNames("clockify_invoice_create", CANDIDATES)).toContain("clockify_invoices_create");
  });

  it("catches a token-order swap (Levenshtein alone would miss this)", () => {
    expect(nearestNames("clockify_create_invoice", CANDIDATES)).toContain("clockify_invoices_create");
  });

  it("catches a single-character typo via edit distance", () => {
    expect(nearestNames("clockfy_status", CANDIDATES)).toContain("clockify_status");
  });

  it("returns nothing for a name with no real similarity (no garbage suggestions)", () => {
    expect(nearestNames("zzz_nope_xyz", CANDIDATES)).toEqual([]);
  });

  it("respects the limit", () => {
    expect(nearestNames("clockify_timer", CANDIDATES, 2).length).toBeLessThanOrEqual(2);
  });

  it("is empty for an empty query", () => {
    expect(nearestNames("", CANDIDATES)).toEqual([]);
  });
});

describe("suggestActionNames (against the real catalog)", () => {
  it("suggests the real action for a near-miss the model might emit", () => {
    expect(suggestActionNames("clockify_log_time")).toContain("clockify_log_work");
  });

  it("returns at most 3 and nothing absurd", () => {
    const out = suggestActionNames("qwerty_nonsense");
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out).not.toContain("clockify_status"); // unrelated → not suggested
  });
});

describe("executeAction unknown_action did-you-mean", () => {
  // The unknown-action branch returns before touching the context.
  const ctx = {} as unknown as ActionContext;

  it("names the nearest real action and marks the error retryable", async () => {
    const result = await executeAction({ actionName: "clockify_log_time", args: {}, context: ctx });
    if (result.kind !== "receipt") throw new Error("expected a receipt");
    const { receipt } = result;
    if (receipt.ok) throw new Error("expected an error receipt");
    expect(receipt.code).toBe("unknown_action");
    expect(receipt.recovery?.hint).toContain("clockify_log_work");
    expect(receipt.recovery?.retryable).toBe(true);
  });

  it("offers no suggestion and stays non-retryable for a truly bogus name", async () => {
    const result = await executeAction({ actionName: "qwerty_nonsense_zzz", args: {}, context: ctx });
    if (result.kind !== "receipt") throw new Error("expected a receipt");
    const { receipt } = result;
    if (receipt.ok) throw new Error("expected an error receipt");
    expect(receipt.recovery?.retryable).toBe(false);
    expect(receipt.recovery?.hint).not.toContain("Did you mean");
  });
});
