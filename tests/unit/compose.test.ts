import { describe, expect, it, vi } from "vitest";
import { runComposition, type CompositionStep } from "../../src/harness/compose.js";
import type { EntityRef } from "../../src/harness/receipts.js";

const ref = (type: string, id: string): EntityRef => ({ type, id, name: id });

function doneStep(
  label: string,
  created: EntityRef[],
  undo?: () => Promise<void>,
  required = true,
): CompositionStep {
  return { label, required, run: async () => ({ kind: "done", created, undo }) };
}

describe("runComposition", () => {
  it("runs steps in order and accumulates created entities", async () => {
    const outcome = await runComposition([
      doneStep("a", [ref("client", "c1")]),
      doneStep("b", [ref("project", "p1")]),
    ]);
    expect(outcome.status.kind).toBe("ok");
    expect(outcome.created.map((r) => r.id)).toEqual(["c1", "p1"]);
  });

  it("short-circuits on a stop step (clarify/preview) WITHOUT rolling back prior creates", async () => {
    const undo = vi.fn(async () => {});
    const third = vi.fn();
    const outcome = await runComposition([
      doneStep("a", [ref("tag", "t1")], undo),
      { label: "b", required: true, run: async () => ({ kind: "stop", result: { kind: "clarify", message: "which?" } }) },
      { label: "c", required: true, run: third as unknown as CompositionStep["run"] },
    ]);
    expect(outcome.status.kind).toBe("stopped");
    if (outcome.status.kind === "stopped") expect(outcome.status.result.kind).toBe("clarify");
    expect(undo).not.toHaveBeenCalled(); // a clarify is not a failure — keep what's done
    expect(third).not.toHaveBeenCalled(); // and don't run later steps
    expect(outcome.created.map((r) => r.id)).toEqual(["t1"]);
  });

  it("rolls back prior created entities in REVERSE order when a required step throws", async () => {
    const order: string[] = [];
    const outcome = await runComposition([
      doneStep("client", [ref("client", "c1")], async () => void order.push("undo-c1")),
      doneStep("project", [ref("project", "p1")], async () => void order.push("undo-p1")),
      { label: "task", required: true, run: async () => { throw new Error("boom"); } },
    ]);
    expect(outcome.status.kind).toBe("failed");
    if (outcome.status.kind === "failed") {
      expect(outcome.status.label).toBe("task");
      expect(outcome.status.message).toContain("boom");
      expect(outcome.status.rolledBack.map((r) => r.id)).toEqual(["p1", "c1"]);
    }
    expect(order).toEqual(["undo-p1", "undo-c1"]);
  });

  it("treats a best-effort (required:false) step failure as a warning and continues", async () => {
    const undo = vi.fn(async () => {});
    const outcome = await runComposition([
      doneStep("client", [ref("client", "c1")], undo),
      { label: "timer", required: false, run: async () => { throw new Error("timer down"); } },
      doneStep("project", [ref("project", "p1")]),
    ]);
    expect(outcome.status.kind).toBe("ok");
    expect(outcome.created.map((r) => r.id)).toEqual(["c1", "p1"]);
    expect(outcome.warnings.some((w) => w.message.includes("timer down"))).toBe(true);
    expect(undo).not.toHaveBeenCalled(); // best-effort failure does NOT roll back
  });

  it("records a rollback warning if an undo itself throws, and still reports the failure", async () => {
    const outcome = await runComposition([
      doneStep("client", [ref("client", "c1")], async () => { throw new Error("delete refused"); }),
      { label: "project", required: true, run: async () => { throw new Error("boom"); } },
    ]);
    expect(outcome.status.kind).toBe("failed");
    if (outcome.status.kind === "failed") {
      expect(outcome.status.rolledBack).toEqual([]); // the undo failed
      expect(outcome.status.rollbackWarnings.some((w) => w.message.includes("delete refused"))).toBe(true);
    }
  });

  it("only registers an undo for created entities (reused entities are never rolled back)", async () => {
    const undoClient = vi.fn(async () => {});
    const outcome = await runComposition([
      { label: "client", required: true, run: async () => ({ kind: "done", reused: [ref("client", "c1")] }) },
      doneStep("project", [ref("project", "p1")], undoClient),
      { label: "task", required: true, run: async () => { throw new Error("x"); } },
    ]);
    expect(outcome.status.kind).toBe("failed");
    if (outcome.status.kind === "failed") {
      expect(outcome.status.rolledBack.map((r) => r.id)).toEqual(["p1"]); // not the reused client
    }
    expect(undoClient).toHaveBeenCalledTimes(1);
  });
});
