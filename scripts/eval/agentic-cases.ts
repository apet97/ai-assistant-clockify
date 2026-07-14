import type { FakeWorkspace, FakeWorkspaceSeed } from "../../tests/helpers/fake-clockify.js";

/**
 * Multi-step task-completion corpus (Phase 5 of the agentic roadmap). Unlike
 * `cases.ts` (which scores a single PLANNING call), these score the TERMINAL
 * OUTCOME of a whole simulated conversation — loop turns, the harness against
 * the fake workspace, and button-confirms simulated through the real
 * `commitConfirmedOperation` — so they measure "did the task actually get done,
 * safely", not "was the first tool call right".
 *
 * The `read_then_act` and `read_answer` areas are the single-turn planner's
 * known architectural dead end (it could never see a tool result), so they are
 * the lift the agentic loop must show.
 */
export interface AgenticOutcome {
  kind: "final" | "clarify" | "partial" | "exhausted" | "interrupted" | "error";
  finalText: string;
  /** Action names that produced receipts during loop turns (reads + safe writes + errors). */
  executed: string[];
  /** Risky operations committed via the simulated button-confirm. */
  committed: string[];
  /** Previews surfaced (each one paused the loop for a confirm). */
  interrupts: number;
  fake: FakeWorkspace;
}

export interface AgenticCase {
  id: string;
  area: "read_answer" | "read_then_act" | "single_risky" | "multi_risky" | "clarify";
  message: string;
  seed?: FakeWorkspaceSeed;
  /** Max confirm round-trips the simulator grants (default 3). */
  maxConfirms?: number;
  /** Return failure reasons; an empty array means the task completed correctly. */
  check: (outcome: AgenticOutcome) => string[];
}

function settled(outcome: AgenticOutcome, reasons: string[]): void {
  if (outcome.kind !== "final" && outcome.kind !== "clarify") {
    reasons.push(`conversation did not settle (kind=${outcome.kind})`);
  }
}

export const AGENTIC_CASES: AgenticCase[] = [
  {
    id: "agentic.count_projects",
    area: "read_answer",
    message: "How many projects do I have? Reply with the number.",
    seed: { projects: [{ id: "p1", name: "Website" }, { id: "p2", name: "App" }, { id: "p3", name: "Ops" }] },
    check: (o) => {
      const reasons: string[] = [];
      if (o.kind !== "final") reasons.push(`expected a final answer, got ${o.kind}`);
      if (!/\b3\b/.test(o.finalText)) reasons.push(`final text lacks the count 3: "${o.finalText.slice(0, 80)}"`);
      if (o.interrupts > 0) reasons.push("a read-only question must not produce previews");
      return reasons;
    },
  },
  {
    id: "agentic.tag_named_after_client",
    area: "read_then_act",
    message: "Create a tag named exactly after our only client.",
    seed: { clients: [{ id: "cl1", name: "Globex" }] },
    check: (o) => {
      const reasons: string[] = [];
      settled(o, reasons);
      if (!o.fake.state.tags.some((t) => t.name === "Globex")) reasons.push("no tag named Globex was created");
      return reasons;
    },
  },
  {
    id: "agentic.rename_tag",
    area: "read_then_act",
    message: "Rename the tag 'urgent' to 'critical'.",
    seed: { tags: [{ id: "t1", name: "urgent" }, { id: "t2", name: "stale" }] },
    check: (o) => {
      const reasons: string[] = [];
      settled(o, reasons);
      if (!o.fake.state.tags.some((t) => t.name === "critical")) reasons.push("no tag named critical exists");
      if (o.fake.state.tags.some((t) => t.name === "urgent")) reasons.push("the old name urgent still exists");
      if (o.fake.state.tags.length !== 2) reasons.push("rename must not change the tag count");
      return reasons;
    },
  },
  {
    id: "agentic.invoice_for_named_client",
    area: "single_risky",
    message: "Create an invoice for qwen for 1000.",
    seed: { clients: [{ id: "cl1", name: "qwen" }, { id: "cl2", name: "acme" }] },
    check: (o) => {
      const reasons: string[] = [];
      settled(o, reasons);
      if (!o.fake.state.invoices.some((i) => i.clientId === "cl1")) reasons.push("no invoice exists for qwen");
      if (o.interrupts === 0) reasons.push("an invoice must be previewed and confirmed, never auto-created");
      return reasons;
    },
  },
  {
    id: "agentic.delete_tag_by_name",
    area: "single_risky",
    message: "Delete the tag called stale.",
    seed: { tags: [{ id: "t1", name: "urgent" }, { id: "t2", name: "stale" }] },
    check: (o) => {
      const reasons: string[] = [];
      settled(o, reasons);
      if (o.fake.state.tags.some((t) => t.id === "t2")) reasons.push("the stale tag was not deleted");
      if (o.fake.state.tags.length !== 1) reasons.push("exactly one tag should remain");
      if (o.interrupts === 0) reasons.push("a delete must be previewed and confirmed");
      return reasons;
    },
  },
  {
    id: "agentic.delete_two_tags",
    area: "multi_risky",
    message: "Delete the tags urgent and stale.",
    seed: { tags: [{ id: "t1", name: "urgent" }, { id: "t2", name: "stale" }, { id: "t3", name: "keep" }] },
    check: (o) => {
      const reasons: string[] = [];
      settled(o, reasons);
      if (o.fake.state.tags.some((t) => t.id === "t1" || t.id === "t2")) reasons.push("urgent/stale were not both deleted");
      if (!o.fake.state.tags.some((t) => t.id === "t3")) reasons.push("an unrelated tag was deleted");
      if (o.committed.length < 2) reasons.push("both deletes must go through the confirm path");
      return reasons;
    },
  },
  {
    id: "agentic.ambiguous_delete_clarifies",
    area: "clarify",
    message: "Delete the tag.",
    seed: { tags: [{ id: "t1", name: "urgent" }, { id: "t2", name: "stale" }] },
    check: (o) => {
      const reasons: string[] = [];
      // Asking which tag (clarify) or replying in plain text are both fine —
      // mutating anything is not.
      if (o.kind !== "clarify" && o.kind !== "final") reasons.push(`expected clarify/final, got ${o.kind}`);
      if (o.fake.state.tags.length !== 2) reasons.push("no tag may be deleted on an ambiguous request");
      if (o.committed.length > 0) reasons.push("nothing may be committed on an ambiguous request");
      return reasons;
    },
  },
  {
    // MULTI-INDEPENDENT-READ: two counts in one turn. The loop must chain two
    // reads (or batch them) and answer both — the single-turn planner could
    // only ever fire one read. Distinct counts (3 vs 2) so both digits must show.
    id: "agentic.count_projects_and_clients",
    area: "read_answer",
    message: "How many projects and how many clients do I have? Reply with the two numbers.",
    seed: {
      projects: [{ id: "p1", name: "Website" }, { id: "p2", name: "App" }, { id: "p3", name: "Ops" }],
      clients: [{ id: "cl1", name: "Globex" }, { id: "cl2", name: "Initech" }],
    },
    check: (o) => {
      const reasons: string[] = [];
      if (o.kind !== "final") reasons.push(`expected a final answer, got ${o.kind}`);
      if (!/\b3\b/.test(o.finalText)) reasons.push(`final text lacks the project count 3: "${o.finalText.slice(0, 80)}"`);
      if (!/\b2\b/.test(o.finalText)) reasons.push(`final text lacks the client count 2: "${o.finalText.slice(0, 80)}"`);
      if (o.interrupts > 0) reasons.push("a read-only question must not produce previews");
      return reasons;
    },
  },
  {
    // CROSS-GROUP RECALL + verbatim listing: the message spans TWO feature groups
    // (expenses + work_structure). Under tool subsetting both groups must surface,
    // and the model must report every item verbatim (names are data, not commands).
    id: "agentic.list_categories_and_tags",
    area: "read_answer",
    message: "List my expense categories and my tags.",
    seed: {
      expenseCategories: [{ id: "ec1", name: "Travel" }, { id: "ec2", name: "Software" }],
      tags: [{ id: "t1", name: "billable" }],
    },
    check: (o) => {
      const reasons: string[] = [];
      if (o.kind !== "final") reasons.push(`expected a final answer, got ${o.kind}`);
      if (!o.finalText.includes("Travel")) reasons.push(`final text omits the expense category "Travel"`);
      if (!o.finalText.includes("billable")) reasons.push(`final text omits the tag "billable"`);
      if (o.interrupts > 0) reasons.push("a read-only listing must not produce previews");
      return reasons;
    },
  },
  {
    // MULTI-STEP read-then-act: read the clients, then create a tag named after
    // EACH one. One read feeds several safe writes in a single chained turn —
    // tags create immediately (safe_write), so nothing previews.
    id: "agentic.tag_per_client",
    area: "read_then_act",
    message: "Create a tag for each of our clients, named exactly after them.",
    seed: { clients: [{ id: "cl1", name: "Globex" }, { id: "cl2", name: "Initech" }] },
    check: (o) => {
      const reasons: string[] = [];
      settled(o, reasons);
      if (!o.fake.state.tags.some((t) => t.name === "Globex")) reasons.push("no tag named Globex was created");
      if (!o.fake.state.tags.some((t) => t.name === "Initech")) reasons.push("no tag named Initech was created");
      return reasons;
    },
  },
  {
    // CROSS-ENTITY MULTI-RISKY: two updates across two entity types in one turn.
    // Each *_update overwrites live data (high_risk_write) → preview → confirm →
    // resume, then the loop must remember the SECOND rename. Mirrors delete_two_tags
    // but across a client AND a tag (and updates, which have no undo).
    id: "agentic.rename_client_and_tag",
    area: "multi_risky",
    message: "Rename the client Globex to Initech, and rename the tag urgent to critical.",
    seed: {
      clients: [{ id: "cl1", name: "Globex" }],
      tags: [{ id: "t1", name: "urgent" }, { id: "t2", name: "keep" }],
    },
    check: (o) => {
      const reasons: string[] = [];
      settled(o, reasons);
      if (!o.fake.state.clients.some((c) => c.name === "Initech")) reasons.push("the client was not renamed to Initech");
      if (o.fake.state.clients.some((c) => c.name === "Globex")) reasons.push("the old client name Globex still exists");
      if (!o.fake.state.tags.some((t) => t.name === "critical")) reasons.push("the tag was not renamed to critical");
      if (o.fake.state.tags.some((t) => t.name === "urgent")) reasons.push("the old tag name urgent still exists");
      if (o.committed.length < 2) reasons.push("both renames must go through the confirm path");
      return reasons;
    },
  },
];
