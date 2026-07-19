import { describe, expect, it } from "vitest";
import { errorReceipt, successReceipt } from "../../src/harness/receipts.js";
import {
  recordConfirmedOutcome,
  scoreConfirmedOutcomes,
  type ConfirmedActionOutcome,
} from "../../scripts/eval/confirmed-outcomes.js";

describe("agentic evaluator confirmed outcomes", () => {
  it("does not count definitive failure, unknown outcome, or partial settlement as success", () => {
    const successful: string[] = [];
    const outcomes: ConfirmedActionOutcome[] = [];
    const action = "clockify_invoices_create";

    recordConfirmedOutcome(action, errorReceipt({ action, code: "write_failed", message: "failed" }), successful, outcomes);
    recordConfirmedOutcome(action, errorReceipt({ action, code: "commit_outcome_unknown", message: "unknown" }), successful, outcomes);
    recordConfirmedOutcome(action, {
      kind: "partial",
      receipt: successReceipt({ action, entity: "invoice" }),
      message: "partial",
      recovery: { hint: "inspect", retryable: false },
    }, successful, outcomes);

    expect(successful).toEqual([]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "definitive_failed",
      "outcome_unknown",
      "partial",
    ]);
  });

  it("counts only an exact successful receipt", () => {
    const successful: string[] = [];
    const outcomes: ConfirmedActionOutcome[] = [];
    recordConfirmedOutcome(
      "clockify_invoices_create",
      successReceipt({ action: "clockify_invoices_create", entity: "invoice" }),
      successful,
      outcomes,
    );
    expect(successful).toEqual(["clockify_invoices_create"]);
    expect(outcomes).toEqual([{ action: "clockify_invoices_create", status: "succeeded" }]);
  });

  it("globally fails every non-success settlement, including mixed success and partial outcomes", () => {
    expect(scoreConfirmedOutcomes([
      { action: "clockify_tags_delete", status: "succeeded" },
      { action: "clockify_delete_entity", status: "partial" },
      { action: "clockify_invoices_create", status: "definitive_failed" },
      { action: "clockify_projects_archive", status: "outcome_unknown" },
    ])).toEqual([
      "clockify_delete_entity confirmation settled as partial",
      "clockify_invoices_create confirmation settled as definitive_failed",
      "clockify_projects_archive confirmation settled as outcome_unknown",
    ]);
  });
});
