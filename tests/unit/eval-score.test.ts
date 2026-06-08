import { describe, expect, it } from "vitest";
import { scoreCase, type ExpectSpec } from "../../src/eval/score.js";
import type { ModelPlan } from "../../src/assistant/planner.js";

function actionsPlan(actions: { name: string; arguments?: Record<string, unknown> }[]): ModelPlan {
  return {
    kind: "actions",
    text: "ok",
    actions: actions.map((a) => ({ name: a.name, arguments: a.arguments ?? {} })),
  };
}

describe("scoreCase", () => {
  it("passes when the expected action is proposed", () => {
    const plan = actionsPlan([{ name: "clockify_status" }]);
    const result = scoreCase(plan, { action: "clockify_status" });
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails when the expected action is absent, naming what it got", () => {
    const plan = actionsPlan([{ name: "clockify_tags_list" }]);
    const result = scoreCase(plan, { action: "clockify_status" });
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("clockify_status");
    expect(result.reasons.join(" ")).toContain("clockify_tags_list");
  });

  it("matches an action in a set (anyAction)", () => {
    const plan = actionsPlan([{ name: "clockify_list_entities", arguments: { entityType: "project" } }]);
    expect(scoreCase(plan, { anyAction: ["clockify_projects_list", "clockify_list_entities"] }).pass).toBe(true);
    expect(scoreCase(plan, { anyAction: ["clockify_projects_list"] }).pass).toBe(false);
  });

  it("checks the plan kind", () => {
    const answer: ModelPlan = { kind: "answer", text: "It is sunny." };
    expect(scoreCase(answer, { kind: "answer" }).pass).toBe(true);
    expect(scoreCase(answer, { kind: "clarify" }).pass).toBe(false);
  });

  it("checks that required arg keys are present on the matched action", () => {
    const plan = actionsPlan([{ name: "clockify_invoices_create", arguments: { clientName: "qwen" } }]);
    expect(scoreCase(plan, { action: "clockify_invoices_create", args: { present: ["clientName"] } }).pass).toBe(true);
    expect(
      scoreCase(plan, { action: "clockify_invoices_create", args: { present: ["clientName", "items"] } }).pass,
    ).toBe(false);
  });

  it("checks presentAny — at least one of the listed keys is present", () => {
    const flat = actionsPlan([{ name: "clockify_create_work_package", arguments: { projectName: "Apollo" } }]);
    const nested = actionsPlan([{ name: "clockify_create_work_package", arguments: { project: { name: "Apollo" } } }]);
    const matcher: ExpectSpec = {
      action: "clockify_create_work_package",
      args: { presentAny: ["project", "projectName"] },
    };
    expect(scoreCase(flat, matcher).pass).toBe(true);
    expect(scoreCase(nested, matcher).pass).toBe(true);
    expect(scoreCase(actionsPlan([{ name: "clockify_create_work_package", arguments: {} }]), matcher).pass).toBe(false);
  });

  it("checks an exact arg value (equals)", () => {
    const plan = actionsPlan([{ name: "clockify_create_work_package", arguments: { startTimer: true } }]);
    expect(
      scoreCase(plan, { action: "clockify_create_work_package", args: { equals: { startTimer: true } } }).pass,
    ).toBe(true);
    expect(
      scoreCase(plan, { action: "clockify_create_work_package", args: { equals: { startTimer: false } } }).pass,
    ).toBe(false);
  });

  it("noDestructive flags any proposed action whose risk is destructive (via riskFor)", () => {
    const riskFor = (name: string): readonly string[] =>
      name === "clockify_delete_entity" ? ["destructive"] : ["read"];
    const deletes = actionsPlan([{ name: "clockify_delete_entity", arguments: { entityType: "project", id: "x" } }]);
    const reads = actionsPlan([{ name: "clockify_status" }]);
    expect(scoreCase(deletes, { noDestructive: true }, { riskFor }).pass).toBe(false);
    expect(scoreCase(reads, { noDestructive: true }, { riskFor }).pass).toBe(true);
  });

  it("noDestructive is satisfied by a non-action answer", () => {
    const answer: ModelPlan = { kind: "answer", text: "I can't do that." };
    expect(scoreCase(answer, { kind: "answer", noDestructive: true }, { riskFor: () => ["destructive"] }).pass).toBe(
      true,
    );
  });

  it("combines matchers with AND — all must hold", () => {
    const plan = actionsPlan([{ name: "clockify_invoices_create", arguments: { clientName: "qwen" } }]);
    const good = scoreCase(plan, {
      kind: "actions",
      action: "clockify_invoices_create",
      args: { present: ["clientName"] },
    });
    expect(good.pass).toBe(true);

    const bad = scoreCase(plan, {
      kind: "clarify", // wrong
      action: "clockify_invoices_create",
      args: { present: ["clientName"] },
    });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.length).toBe(1); // only the kind matcher failed
    expect(bad.reasons[0]).toContain("kind");
  });
});
