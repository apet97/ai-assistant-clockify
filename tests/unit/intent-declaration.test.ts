import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DECLARE_INTENT_TOOL_NAME,
  declareIntentCapability,
  filterCatalogByIntentCapability,
} from "../../src/assistant/intent-declaration.js";
import { buildCandidateWriteActionNames } from "../../src/assistant/intent-candidates.js";
import type { ModelClient, ModelMessage, ToolDefinition } from "../../src/assistant/model-client.js";
import type { ActionCatalogEntry } from "../../src/harness/action.js";
import { ACTION_CATALOG, getAction } from "../../src/harness/catalog.js";
import { authorizeIntentWriteArguments } from "../../src/harness/intent-authority.js";
import { hashIntentCapability } from "../../src/harness/intent-capability.js";
import { createStore } from "../../src/db/store.js";
import { selectActionsForMessage } from "../../src/harness/tool-select.js";

const catalogHash = createHash("sha256").update("test-catalog").digest("hex");
const writeActionNames = ["clockify_projects_update", "clockify_invoices_create"] as const;

function byteSpan(authoredText: string, literal: string): { startByte: number; endByte: number; text: string } {
  const characterStart = authoredText.indexOf(literal);
  if (characterStart < 0) throw new Error(`Missing test literal: ${literal}`);
  const startByte = Buffer.byteLength(authoredText.slice(0, characterStart), "utf8");
  return { startByte, endByte: startByte + Buffer.byteLength(literal, "utf8"), text: literal };
}

function byteSpanAt(
  authoredText: string,
  literal: string,
  occurrence: number,
): { startByte: number; endByte: number; text: string } {
  let characterStart = -1;
  let searchFrom = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    characterStart = authoredText.indexOf(literal, searchFrom);
    if (characterStart < 0) throw new Error(`Missing test literal occurrence: ${literal}#${occurrence}`);
    searchFrom = characterStart + literal.length;
  }
  const startByte = Buffer.byteLength(authoredText.slice(0, characterStart), "utf8");
  return { startByte, endByte: startByte + Buffer.byteLength(literal, "utf8"), text: literal };
}

function nativeModel(
  args: Record<string, unknown>,
  capture?: { messages?: ModelMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal; retryTransient?: boolean },
): ModelClient {
  return {
    complete: vi.fn(async () => {
      throw new Error("JSON fallback must not run for a native client");
    }),
    completeWithTools: vi.fn(async (messages, tools, signal, options) => {
      if (capture) Object.assign(capture, { messages, tools, signal, retryTransient: options?.retryTransient });
      return {
        text: "",
        toolCalls: [{ id: "declare-1", name: DECLARE_INTENT_TOOL_NAME, arguments: args }],
      };
    }),
  };
}

function declaration(actionName: string, sourceSpan: { startByte: number; endByte: number; text: string }) {
  return {
    writeActions: [{
      actionName,
      sourceSpans: [sourceSpan],
      literalConstraints: [{ path: "name", value: sourceSpan.text, sourceSpan }],
      maxExecutions: 1,
    }],
  };
}

function quotedSafeWrite(
  actionName: string,
  currentText: string,
  constraints: ReadonlyArray<{ path: string; value: unknown; quote: string }>,
) {
  return {
    writeActions: [{
      actionName,
      sourceRefs: [{ segment: "current", quote: currentText.replace(/[.]$/u, "") }],
      literalConstraints: constraints.map((constraint) => ({
        path: constraint.path,
        value: constraint.value,
        sourceRef: { segment: "current", quote: constraint.quote },
      })),
      maxExecutions: 1,
    }],
  };
}

describe("declareIntentCapability", () => {
  it("distinguishes a valid read-only declaration from a malformed write declaration", async () => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({ writeActions: [] }),
      currentText: "What did I track today?",
      writeActionNames,
      catalogHash,
    });

    expect(capability).toMatchObject({
      mode: "deny_all_writes",
      reason: "no_write_intent",
      writeActions: [],
    });
  });

  it.each([
    ["clockify_start_timer", "Start a timer.", []],
    ["clockify_stop_timer", "Stop the timer.", []],
    ["clockify_log_work", "Log 2 hours today.", [
      { path: "durationHours", value: 2, quote: "2" },
      { path: "date", value: "today", quote: "today" },
    ]],
    ["clockify_create_work_package", "Create a work package with tag Urgent and project Apollo.", [
      { path: "tagName", value: "Urgent", quote: "Urgent" },
      { path: "projectName", value: "Apollo", quote: "Apollo" },
    ]],
    ["clockify_projects_create", "Create project Atlas.", [
      { path: "name", value: "Atlas", quote: "Atlas" },
    ]],
    ["clockify_projects_from_template", "Create project Atlas from template Base.", [
      { path: "name", value: "Atlas", quote: "Atlas" },
      { path: "templateName", value: "Base", quote: "Base" },
    ]],
    ["clockify_tasks_create", "Create task Review in project p1.", [
      { path: "name", value: "Review", quote: "Review" },
      { path: "projectId", value: "p1", quote: "p1" },
    ]],
    ["clockify_clients_create", "Create client Acme.", [
      { path: "name", value: "Acme", quote: "Acme" },
    ]],
    ["clockify_tags_create", "Create a new tag named Urgent.", [
      { path: "name", value: "Urgent", quote: "Urgent" },
    ]],
    ["clockify_holidays_create", "Create holiday Founders on 2026-07-20 for Alice.", [
      { path: "name", value: "Founders", quote: "Founders" },
      { path: "startDate", value: "2026-07-20", quote: "2026-07-20" },
      { path: "userIds[0]", value: "Alice", quote: "Alice" },
    ]],
    ["clockify_scheduling_assignments_create", "Schedule Alice on project p1 from 2026-07-20 to 2026-07-21 for 8 hours.", [
      { path: "userId", value: "Alice", quote: "Alice" },
      { path: "projectId", value: "p1", quote: "p1" },
      { path: "start", value: "2026-07-20", quote: "2026-07-20" },
      { path: "end", value: "2026-07-21", quote: "2026-07-21" },
      { path: "hoursPerDay", value: 8, quote: "8" },
    ]],
  ] as const)("allows the minimal role-correct safe-write declaration: %s", async (actionName, currentText, constraints) => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel(quotedSafeWrite(actionName, currentText, constraints)),
      currentText,
      writeActionNames: [actionName],
      catalogHash,
    });
    expect(capability).toMatchObject({ mode: "allow" });
  });

  it.each([
    ["clockify_start_timer", "How long has my timer been running?", []],
    ["clockify_stop_timer", "When did the timer stop?", []],
    ["clockify_log_work", "Log 2 hours today.", [
      { path: "date", value: "today", quote: "today" },
    ]],
    ["clockify_create_work_package", "Create client Acme and project Apollo.", [
      { path: "projectName", value: "Apollo", quote: "Apollo" },
    ]],
    ["clockify_projects_create", "Create a public project named Atlas.", [
      { path: "name", value: "Atlas", quote: "Atlas" },
    ]],
    ["clockify_projects_from_template", "Which project was created from template Base?", [
      { path: "name", value: "Atlas", quote: "project" },
      { path: "templateName", value: "Base", quote: "Base" },
    ]],
    ["clockify_tasks_create", "Create task Review in project p1 for Alice.", [
      { path: "name", value: "Review", quote: "Review" },
      { path: "projectId", value: "p1", quote: "p1" },
    ]],
    ["clockify_clients_create", "Create client Acme with currency EUR.", [
      { path: "name", value: "Acme", quote: "Acme" },
    ]],
    ["clockify_tags_create", "Was tag Urgent created?", [
      { path: "name", value: "Urgent", quote: "Urgent" },
    ]],
    ["clockify_holidays_create", "Create holiday Founders from 2026-07-20 to 2026-07-21 annually for Alice.", [
      { path: "name", value: "Founders", quote: "Founders" },
      { path: "startDate", value: "2026-07-20", quote: "2026-07-20" },
      { path: "userIds[0]", value: "Alice", quote: "Alice" },
    ]],
    ["clockify_scheduling_assignments_create", "Schedule Alice on project p1 from 2026-07-20 to 2026-07-21 for 8 hours with note Focus.", [
      { path: "userId", value: "Alice", quote: "Alice" },
      { path: "projectId", value: "p1", quote: "p1" },
      { path: "start", value: "2026-07-20", quote: "2026-07-20" },
      { path: "end", value: "2026-07-21", quote: "2026-07-21" },
      { path: "hoursPerDay", value: 8, quote: "8" },
    ]],
  ] as const)("denies an under-declared or non-command safe-write mapping: %s", async (actionName, currentText, constraints) => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel(quotedSafeWrite(actionName, currentText, constraints)),
      currentText,
      writeActionNames: [actionName],
      catalogHash,
    });
    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("grounds one structured JSON constraint from an exact authored span", async () => {
    const currentText = 'Create an invoice with items [{"description":"Audit","quantity":2}]';
    const span = byteSpan(currentText, '[{"description":"Audit","quantity":2}]');
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_custom_fields_set_value_project",
          sourceSpans: [span],
          literalConstraints: [{
            path: "value",
            value: [{ description: "Audit", quantity: 2 }],
            sourceSpan: span,
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_custom_fields_set_value_project"],
      catalogHash,
    });

    expect(capability).toMatchObject({
      version: 1,
      mode: "allow",
      writeActions: [{ literalConstraints: [{ value: [{ description: "Audit", quantity: 2 }] }] }],
    });
  });

  it.each([
    ["public", true],
    ["private", false],
    ["non-public", false],
  ] as const)("grounds the reviewed project visibility alias %s without weakening boolean grounding", async (authored, value) => {
    const currentText = `Create a ${authored} project named RC-LIVE.`;
    const actionSpan = byteSpan(currentText, `Create a ${authored} project`);
    const visibilitySpan = byteSpan(currentText, authored);
    const nameSpan = byteSpan(currentText, "RC-LIVE");

    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: actionSpan.text }],
          literalConstraints: [
            { path: "name", value: "RC-LIVE", sourceRef: { segment: "current", quote: nameSpan.text } },
            { path: "isPublic", value, sourceRef: { segment: "current", quote: visibilitySpan.text } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({
      mode: "allow",
      writeActions: [{
        actionName: "clockify_projects_create",
        literalConstraints: [
          { path: "name", value: "RC-LIVE" },
          { path: "isPublic", value },
        ],
      }],
    });
  });

  it("keeps semantic boolean aliases action-and-path scoped", async () => {
    const currentText = "Create a public project named RC-LIVE.";
    const publicSpan = byteSpan(currentText, "public");
    const nameSpan = byteSpan(currentText, "RC-LIVE");
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceSpans: [byteSpan(currentText, "Create a public project"), publicSpan, nameSpan],
          literalConstraints: [
            { path: "name", value: "RC-LIVE", sourceSpan: nameSpan },
            // "public" is reviewed only as project visibility, never as a
            // generic synonym for an unrelated true boolean.
            { path: "billable", value: true, sourceSpan: publicSpan },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("rejects a timer declaration that omits an explicitly authored project target", async () => {
    const currentText = "Start a timer at project Apollo.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_start_timer",
          sourceRefs: [{ segment: "current", quote: "Start a timer" }],
          literalConstraints: [],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_start_timer"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("allows a genuinely untied timer declaration to keep zero literal constraints", async () => {
    const currentText = "Start a timer.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_start_timer",
          sourceRefs: [{ segment: "current", quote: "Start a timer" }],
          literalConstraints: [],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_start_timer"],
      catalogHash,
    });

    expect(capability).toMatchObject({
      mode: "allow",
      writeActions: [{ actionName: "clockify_start_timer", literalConstraints: [] }],
    });
  });

  it.each([
    {
      label: "correct timer target and description roles",
      projectValue: "Apollo",
      projectQuote: "Apollo",
      descriptionValue: "Focus",
      descriptionQuote: "Focus",
      mode: "allow",
    },
    {
      label: "swapped timer target and description roles",
      projectValue: "Focus",
      projectQuote: "Focus",
      descriptionValue: "Apollo",
      descriptionQuote: "Apollo",
      mode: "deny_all_writes",
    },
  ] as const)("binds same-typed literals to their authored role: $label", async (fixture) => {
    const currentText = "Start a timer at project Apollo with description Focus.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_start_timer",
          sourceRefs: [{ segment: "current", quote: "Start a timer at project Apollo with description Focus" }],
          literalConstraints: [
            {
              path: "projectName",
              value: fixture.projectValue,
              sourceRef: { segment: "current", quote: fixture.projectQuote },
            },
            {
              path: "description",
              value: fixture.descriptionValue,
              sourceRef: { segment: "current", quote: fixture.descriptionQuote },
            },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_start_timer"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: fixture.mode });
  });

  it("accepts a role-bound indexed tag constraint", async () => {
    const currentText = "Start a timer tagged urgent.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_start_timer",
          sourceRefs: [{ segment: "current", quote: "Start a timer tagged urgent" }],
          literalConstraints: [{
            path: "tagNames[0]",
            value: "urgent",
            sourceRef: { segment: "current", quote: "urgent" },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_start_timer"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "allow" });
  });

  it.each([
    "Cancel that.",
    "Actually, never mind.",
    "No, cancel that.",
    "No thanks, cancel it.",
  ])("lets the current admin cancel a retained prior write command: %s", async (currentText) => {
    const unresolvedPriorText = "Start a timer at project Apollo.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_start_timer",
          sourceRefs: [{ segment: "unresolved_prior", quote: "Start a timer at project Apollo" }],
          literalConstraints: [{
            path: "projectName",
            value: "Apollo",
            sourceRef: { segment: "unresolved_prior", quote: "Apollo" },
          }],
          maxExecutions: 1,
        }],
      }),
      unresolvedPriorText,
      currentText,
      writeActionNames: ["clockify_start_timer"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it.each([
    "Create project Atlas, never mind.",
    "Create project Atlas, please cancel that.",
    "Create project Atlas. Never mind.",
    "Create project Atlas; cancel that.",
    "Create project Atlas? No.",
  ])("denies a current-turn safe write revoked after the command: %s", async (currentText) => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel(quotedSafeWrite("clockify_projects_create", currentText, [
        { path: "name", value: "Atlas", quote: "Atlas" },
      ])),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("keeps No as a literal project name when it is part of the command", async () => {
    const currentText = "Create project No.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel(quotedSafeWrite("clockify_projects_create", currentText, [
        { path: "name", value: "No", quote: "No" },
      ])),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({
      mode: "allow",
      writeActions: [{ literalConstraints: [{ path: "name", value: "No" }] }],
    });
  });

  it("binds one terse clarification literal to the uniquely cued prior role", async () => {
    const unresolvedPriorText = "Start a timer on project";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_start_timer",
          sourceRefs: [{ segment: "unresolved_prior", quote: "Start a timer on project" }],
          literalConstraints: [{
            path: "projectName",
            value: "Apollo",
            sourceRef: { segment: "current", quote: "Apollo" },
          }],
          maxExecutions: 1,
        }],
      }),
      unresolvedPriorText,
      currentText: "Apollo",
      writeActionNames: ["clockify_start_timer"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "allow" });
  });

  it.each([
    {
      label: "public inside not public",
      currentText: "Create a not public project named RC-LIVE.",
      path: "isPublic",
      value: true,
      selectedQuote: "public",
      actionQuote: "Create a not public project",
    },
    {
      label: "billable inside non-billable",
      currentText: "Create a non-billable project named RC-LIVE.",
      path: "billable",
      value: true,
      selectedQuote: "billable",
      actionQuote: "Create a non-billable project",
    },
    {
      label: "billable inside unbillable",
      currentText: "Create an unbillable project named RC-LIVE.",
      path: "billable",
      value: true,
      selectedQuote: "billable",
      actionQuote: "Create an unbillable project",
    },
    {
      label: "billable inside rebillable",
      currentText: "Create a rebillable project named RC-LIVE.",
      path: "billable",
      value: true,
      selectedQuote: "billable",
      actionQuote: "Create a rebillable project",
    },
    {
      label: "billable inside a Unicode word",
      currentText: "Create a prébillable project named RC-LIVE.",
      path: "billable",
      value: true,
      selectedQuote: "billable",
      actionQuote: "Create a prébillable project",
    },
    {
      label: "quoted public inside an unreviewed negated phrase",
      currentText: 'Create a not "public" project named RC-LIVE.',
      path: "isPublic",
      value: true,
      selectedQuote: '"public"',
      actionQuote: 'Create a not "public" project',
    },
  ])("denies polarity inversion from a shorter alias: $label", async (fixture) => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: fixture.actionQuote }],
          literalConstraints: [
            { path: "name", value: "RC-LIVE", sourceRef: { segment: "current", quote: "RC-LIVE" } },
            {
              path: fixture.path,
              value: fixture.value,
              sourceRef: { segment: "current", quote: fixture.selectedQuote },
            },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText: fixture.currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("accepts a reviewed billable alias at a punctuation-delimited whole-token boundary", async () => {
    const currentText = "Create a project named RC-LIVE, billable.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: "Create a project named RC-LIVE, billable" }],
          literalConstraints: [
            { path: "name", value: "RC-LIVE", sourceRef: { segment: "current", quote: "RC-LIVE" } },
            { path: "billable", value: true, sourceRef: { segment: "current", quote: "billable" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({
      mode: "allow",
      writeActions: [{
        literalConstraints: expect.arrayContaining([
          expect.objectContaining({ path: "billable", value: true }),
        ]),
      }],
    });
  });

  it.each([
    ["case-insensitive negation", "Create a NOT public project named RC-LIVE.", "public"],
    ["hyphenated negation", "Create a non-public project named RC-LIVE.", "public"],
    ["padded quote", "Create a not public project named RC-LIVE.", " public "],
  ])("denies semantic-alias inversion through %s", async (_label, currentText, selectedQuote) => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: currentText.slice(0, -1) }],
          literalConstraints: [
            { path: "name", value: "RC-LIVE", sourceRef: { segment: "current", quote: "RC-LIVE" } },
            { path: "isPublic", value: true, sourceRef: { segment: "current", quote: selectedQuote } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("denies reuse of one authored span for different literal paths", async () => {
    const currentText = "Create a project named public.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: "Create a project named public" }],
          literalConstraints: [
            { path: "name", value: "public", sourceRef: { segment: "current", quote: "public" } },
            { path: "isPublic", value: true, sourceRef: { segment: "current", quote: "public" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("denies overlapping authored spans reused across different literal paths", async () => {
    const currentText = "Create a project named public project.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: "Create a project named public project" }],
          literalConstraints: [
            { path: "name", value: "public project", sourceRef: { segment: "current", quote: "public project" } },
            { path: "isPublic", value: true, sourceRef: { segment: "current", quote: "public" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("fails closed when any advertised write action lacks a declaration authority contract", async () => {
    const capture: { messages?: ModelMessage[] } = {};
    const capability = await declareIntentCapability({
      modelClient: nativeModel({ writeActions: [] }, capture),
      currentText: "Set reports to read.",
      writeActionNames: ["missing_write_action"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
    expect(capture.messages).toBeUndefined();
  });

  it.each([
    ["clockify_start_timer", "billable", true, "Start a non-billable timer.", "non-billable", "billable"],
    ["clockify_entries_mark_invoiced", "invoiced", true, "Mark these as not invoiced.", "not invoiced", "invoiced"],
    ["clockify_scheduling_publish", "notifyUsers", true, "Publish but do not notify users.", "do not notify users", "notify users"],
    ["clockify_users_invite", "sendEmail", true, "Invite them but do not send email.", "do not send email", "send email"],
  ] as const)(
    "applies opposite-polarity containment to %s.%s",
    async (actionName, path, value, currentText, actionQuote, selectedQuote) => {
      const capability = await declareIntentCapability({
        modelClient: nativeModel({
          writeActions: [{
            actionName,
            sourceRefs: [{ segment: "current", quote: actionQuote }],
            literalConstraints: [{
              path,
              value,
              sourceRef: { segment: "current", quote: selectedQuote },
            }],
            maxExecutions: 1,
          }],
        }),
        currentText,
        writeActionNames: [actionName],
        catalogHash,
      });

      expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
    },
  );

  it("uses the named authored segment to disambiguate the same quote across clarification turns", async () => {
    const unresolvedPriorText = "Did you mean Atlas?";
    const currentText = "Yes, rename it to Atlas.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_update",
          sourceRefs: [{ segment: "current", quote: "rename it to Atlas" }],
          literalConstraints: [
            { path: "name", value: "Atlas", sourceRef: { segment: "current", quote: "Atlas" } },
          ],
          maxExecutions: 1,
        }],
      }),
      unresolvedPriorText,
      currentText,
      writeActionNames: ["clockify_projects_update"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "allow" });
    expect(capability.writeActions[0]?.literalConstraints[0]?.sourceSpan.startByte)
      .toBe(Buffer.byteLength(`${unresolvedPriorText}\nYes, rename it to `, "utf8"));
  });

  it.each([
    ["public cannot mean false", "public", false],
    ["private cannot mean true", "private", true],
    ["an unreviewed visibility word cannot synthesize true", "shared", true],
  ] as const)("denies %s", async (_label, authored, value) => {
    const currentText = `Create a ${authored} project named RC-LIVE.`;
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: `Create a ${authored} project` }],
          literalConstraints: [
            { path: "name", value: "RC-LIVE", sourceRef: { segment: "current", quote: "RC-LIVE" } },
            { path: "isPublic", value, sourceRef: { segment: "current", quote: authored } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("accepts one native declaration and produces an immutable allow capability", async () => {
    const currentText = "Rename the project to Atlas.";
    const span = byteSpan(currentText, "Atlas");

    const capability = await declareIntentCapability({
      modelClient: nativeModel(declaration("clockify_projects_update", span)),
      currentText,
      writeActionNames,
      catalogHash,
    });

    expect(capability).toEqual({
      version: 1,
      mode: "allow",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      catalogHash,
      writeActions: [{
        actionName: "clockify_projects_update",
        sourceSpans: [span],
        literalConstraints: [{ path: "name", value: "Atlas", sourceSpan: span }],
        maxExecutions: 1,
      }],
    });
  });

  it("computes immutable UTF-8 capability spans from unambiguous model source quotes", async () => {
    const currentText = "Napravi public projekat Žetva.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: "Napravi public projekat Žetva" }],
          literalConstraints: [
            { path: "name", value: "Žetva", sourceRef: { segment: "current", quote: "Žetva" } },
            { path: "isPublic", value: true, sourceRef: { segment: "current", quote: "public" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "allow" });
    const constraints = capability.writeActions[0]?.literalConstraints ?? [];
    expect(constraints.find((constraint) => constraint.path === "name")?.sourceSpan)
      .toEqual(byteSpan(currentText, "Žetva"));
  });

  it.each([
    ["absent", "Create project Atlas.", { segment: "current", quote: "Vega" }],
    ["ambiguous", "Create Atlas, then rename Atlas.", { segment: "current", quote: "Atlas" }],
  ])("denies an %s model source quote rather than guessing a span", async (_label, currentText, sourceRef) => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [sourceRef],
          literalConstraints: [{ path: "name", value: sourceRef.quote, sourceRef }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("grounds an explicit zero-based occurrence of a repeated literal", async () => {
    const currentText = "Check client Globex, then create one tag named Globex.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_tags_create",
          sourceRefs: [{ segment: "current", quote: "create one tag named Globex", occurrence: 0 }],
          literalConstraints: [{
            path: "name",
            value: "Globex",
            sourceRef: { segment: "current", quote: "Globex", occurrence: 1 },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_tags_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "allow" });
    expect(capability.writeActions[0]?.literalConstraints[0]?.sourceSpan)
      .toEqual(byteSpanAt(currentText, "Globex", 1));
  });

  it.each([-1, 1.5, 1024])("denies an invalid quote occurrence %s", async (occurrence) => {
    const currentText = "Create tag Globex.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_tags_create",
          sourceRefs: [{ segment: "current", quote: "Create tag Globex", occurrence: 0 }],
          literalConstraints: [{
            path: "name",
            value: "Globex",
            sourceRef: { segment: "current", quote: "Globex", occurrence },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_tags_create"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("uses UTF-8 byte offsets and validates Serbian Latin, diacritics, and Cyrillic exactly", async () => {
    const currentText = "Preimenuj projekat u Žetva za тим Београд.";
    const span = byteSpan(currentText, "Žetva");
    const cyrillicSpan = byteSpan(currentText, "Београд");
    const actionSpan = byteSpan(currentText, "Preimenuj");
    const payload = {
      writeActions: [{
        actionName: "clockify_projects_update",
        sourceSpans: [actionSpan, span, cyrillicSpan],
        literalConstraints: [
          { path: "name", value: "Žetva", sourceSpan: span },
          { path: "color", value: "Београд", sourceSpan: cyrillicSpan },
        ],
        maxExecutions: 1,
      }],
    };

    const capability = await declareIntentCapability({
      modelClient: nativeModel(payload),
      currentText,
      writeActionNames,
      catalogHash,
    });

    expect(cyrillicSpan.startByte).toBeGreaterThan(currentText.indexOf("Београд"));
    expect(capability.mode).toBe("allow");
    expect(capability.writeActions[0]?.literalConstraints[0]?.sourceSpan).toEqual(span);
    expect(capability.writeActions[0]?.literalConstraints[1]?.sourceSpan).toEqual(cyrillicSpan);
  });

  it("sends only current and unresolved prior admin-authored segments plus the allowlist/hash", async () => {
    const capture: {
      messages?: ModelMessage[];
      tools?: ToolDefinition[];
      signal?: AbortSignal;
      retryTransient?: boolean;
    } = {};
    const unresolvedPriorText = "Which project? Atlas or Vega?";
    const currentText = "Atlas, and rename it to Žetva.";
    const canonicalText = `${unresolvedPriorText}\n${currentText}`;
    const span = byteSpan(canonicalText, "Žetva");

    await declareIntentCapability({
      modelClient: nativeModel(declaration("clockify_projects_update", span), capture),
      currentText,
      unresolvedPriorText,
      writeActionNames,
      catalogHash,
    });

    expect(capture.messages).toHaveLength(2);
    expect(capture.messages?.map((message) => message.role)).toEqual(["system", "user"]);
    const payload = JSON.parse(capture.messages?.[1]?.content ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: 1,
      offsetEncoding: "utf8-bytes",
      catalogHash,
      writeActionNames: [...writeActionNames],
      writeActionContracts: expect.arrayContaining(writeActionNames.map((actionName) =>
        expect.objectContaining({ actionName }))),
      segments: [
        {
          source: "unresolved_prior",
          startByte: 0,
          endByte: Buffer.byteLength(unresolvedPriorText, "utf8"),
          text: unresolvedPriorText,
        },
        {
          source: "current",
          startByte: Buffer.byteLength(`${unresolvedPriorText}\n`, "utf8"),
          endByte: Buffer.byteLength(canonicalText, "utf8"),
          text: currentText,
        },
      ],
    });
    expect(capture.messages?.map((message) => message.content).join("\n")).not.toContain("Clockify result");
    expect(capture.messages?.[0]?.content).toContain("absence is not a denial");
    expect(capture.messages?.[0]?.content).toContain(
      "When requireCurrentActionSpan is true, every declared write must include an exact current sourceRef that expresses that action",
    );
    expect(capture.messages?.[0]?.content).toContain(
      "unresolved_prior may bind literal constraints only and cannot supply the action command",
    );
    expect(capture.tools).toHaveLength(1);
    expect(capture.retryTransient).toBe(false);
    expect(capture.tools?.[0]?.name).toBe(DECLARE_INTENT_TOOL_NAME);
    expect(capture.tools?.[0]?.parameters).toMatchObject({ additionalProperties: false });
    const writeItems = ((capture.tools?.[0]?.parameters as any).properties.writeActions.items) as Record<string, any>;
    expect(writeItems.properties.actionName).toEqual({
      type: "string",
      enum: [...writeActionNames],
    });
    expect(writeItems.properties.literalConstraints.items.properties.sourceRef.properties.quote.description)
      .toContain("shortest exact authored substring");
  });

  it("does not let a carried prior command plus unrelated current filler authorize the action", async () => {
    const unresolvedPriorText = "Rename project Atlas.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_update",
          sourceRefs: [
            { segment: "unresolved_prior", quote: "Rename project Atlas" },
            { segment: "current", quote: "hello" },
          ],
          literalConstraints: [{
            path: "name",
            value: "Atlas",
            sourceRef: { segment: "unresolved_prior", quote: "Atlas" },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText: "hello",
      unresolvedPriorText,
      requireCurrentActionSpan: true,
      writeActionNames,
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("allows an adjacent project name only as the risky update selector", async () => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_update",
          sourceRefs: [
            { segment: "current", quote: "rename that project" },
            { segment: "unresolved_prior", quote: "Atlas" },
            { segment: "current", quote: "Vega" },
          ],
          literalConstraints: [
            { path: "currentName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
            { path: "name", value: "Vega", sourceRef: { segment: "current", quote: "Vega" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText: "rename that project to Vega",
      unresolvedPriorText: "create a project named Atlas",
      requireCurrentActionSpan: true,
      writeActionNames: ["clockify_projects_update"],
      catalogHash,
    });

    expect(capability).toMatchObject({
      mode: "allow",
      writeActions: [expect.objectContaining({
        actionName: "clockify_projects_update",
        literalConstraints: expect.arrayContaining([
          expect.objectContaining({ path: "currentName", value: "Atlas" }),
          expect.objectContaining({ path: "name", value: "Vega" }),
        ]),
      })],
    });
  });

  it("binds the exact adjacent-project privacy, membership, and member-rate request", async () => {
    const writeActions = [
      {
        actionName: "clockify_projects_update",
        sourceRefs: [
          { segment: "current", quote: "make the project private" },
          { segment: "unresolved_prior", quote: "Atlas" },
          { segment: "current", quote: "private" },
        ],
        literalConstraints: [
          { path: "currentName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
          { path: "isPublic", value: false, sourceRef: { segment: "current", quote: "private" } },
        ],
        maxExecutions: 1,
      },
      {
        actionName: "clockify_projects_memberships_update",
        sourceRefs: [
          { segment: "current", quote: "add me to it" },
          { segment: "unresolved_prior", quote: "Atlas" },
          { segment: "current", quote: "me", occurrence: 0 },
        ],
        literalConstraints: [
          { path: "name", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
          { path: "addUserIds[]", value: "me", sourceRef: { segment: "current", quote: "me", occurrence: 0 } },
        ],
        maxExecutions: 1,
      },
      {
        actionName: "clockify_projects_rate_update",
        sourceRefs: [
          { segment: "current", quote: "make my project member rate to be 15" },
          { segment: "unresolved_prior", quote: "Atlas" },
          { segment: "current", quote: "my" },
          { segment: "current", quote: "project member rate" },
          { segment: "current", quote: "15" },
        ],
        literalConstraints: [
          { path: "projectName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
          { path: "userId", value: "me", sourceRef: { segment: "current", quote: "my" } },
          { path: "rateKind", value: "HOURLY", sourceRef: { segment: "current", quote: "project member rate" } },
          { path: "amount", value: 15, sourceRef: { segment: "current", quote: "15" } },
        ],
        maxExecutions: 1,
      },
    ];
    for (const writeAction of writeActions) {
      const single = await declareIntentCapability({
        modelClient: nativeModel({ writeActions: [writeAction] }),
        currentText: "make the project private, add me to it, and make my project member rate to be 15",
        unresolvedPriorText: "create a project named Atlas",
        requireCurrentActionSpan: true,
        writeActionNames: [writeAction.actionName],
        catalogHash,
      });
      expect(single.mode, writeAction.actionName).toBe("allow");
    }
    const capability = await declareIntentCapability({
      modelClient: nativeModel({ writeActions }),
      currentText: "make the project private, add me to it, and make my project member rate to be 15",
      unresolvedPriorText: "create a project named Atlas",
      requireCurrentActionSpan: true,
      writeActionNames: [
        "clockify_projects_update",
        "clockify_projects_memberships_update",
        "clockify_projects_rate_update",
      ],
      catalogHash,
    });

    expect(capability).toMatchObject({
      mode: "allow",
      writeActions: [
        expect.objectContaining({ actionName: "clockify_projects_update" }),
        expect.objectContaining({ actionName: "clockify_projects_memberships_update" }),
        expect.objectContaining({ actionName: "clockify_projects_rate_update" }),
      ],
    });
  });

  it.each([
    ["don't update that project", "update that project", []],
    [
      "archive that project, never mind",
      "archive that project",
      [{ path: "archived", value: true, sourceRef: { segment: "current", quote: "archive" } }],
    ],
  ])("rejects a negated or cancelled adjacent-project update: %s", async (
    currentText,
    actionQuote,
    extraConstraints,
  ) => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_update",
          sourceRefs: [
            { segment: "current", quote: actionQuote },
            { segment: "unresolved_prior", quote: "Atlas" },
            ...extraConstraints.map(({ sourceRef }) => sourceRef),
          ],
          literalConstraints: [
            { path: "currentName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
            ...extraConstraints,
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      unresolvedPriorText: "create a project named Atlas",
      requireCurrentActionSpan: true,
      writeActionNames: ["clockify_projects_update"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("does not bind a rate command to a project cue in a separate sentence", async () => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_rate_update",
          sourceRefs: [
            { segment: "current", quote: "Set member rate to 15" },
            { segment: "unresolved_prior", quote: "Atlas" },
            { segment: "current", quote: "15" },
          ],
          literalConstraints: [
            { path: "projectName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
            { path: "amount", value: 15, sourceRef: { segment: "current", quote: "15" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText: "Set member rate to 15. Show that project.",
      unresolvedPriorText: "create a project named Atlas",
      requireCurrentActionSpan: true,
      writeActionNames: ["clockify_projects_rate_update"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("rejects an explicit carried cost-rate command when rateKind is undeclared", async () => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_rate_update",
          sourceRefs: [{ segment: "current", quote: "set cost rate to 15 for me on that project" }],
          literalConstraints: [
            { path: "projectName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
            { path: "userId", value: "me", sourceRef: { segment: "current", quote: "me" } },
            { path: "amount", value: 15, sourceRef: { segment: "current", quote: "15" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText: "set cost rate to 15 for me on that project",
      unresolvedPriorText: "create a project named Atlas",
      requireCurrentActionSpan: true,
      writeActionNames: ["clockify_projects_rate_update"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it.each([
    ["HOURLY", "hourly rate"],
    ["COST", "cost rate"],
  ])("rejects a negated carried %s rate canonicalization", async (rateKind, phrase) => {
    const currentText = `set not ${phrase} to 15 for me on that project`;
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_rate_update",
          sourceRefs: [{ segment: "current", quote: currentText }],
          literalConstraints: [
            { path: "projectName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
            { path: "userId", value: "me", sourceRef: { segment: "current", quote: "me" } },
            { path: "rateKind", value: rateKind, sourceRef: { segment: "current", quote: phrase } },
            { path: "amount", value: 15, sourceRef: { segment: "current", quote: "15" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      unresolvedPriorText: "create a project named Atlas",
      requireCurrentActionSpan: true,
      writeActionNames: ["clockify_projects_rate_update"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it.each(["not cost rate", "non-cost rate", "no cost rate"])(
    "rejects the negated carried cost phrase %s",
    async (authoredRate) => {
      const currentText = `set ${authoredRate} to 15 for me on that project`;
      const capability = await declareIntentCapability({
        modelClient: nativeModel({
          writeActions: [{
            actionName: "clockify_projects_rate_update",
            sourceRefs: [{ segment: "current", quote: currentText }],
            literalConstraints: [
              { path: "projectName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
              { path: "userId", value: "me", sourceRef: { segment: "current", quote: "me" } },
              { path: "rateKind", value: "COST", sourceRef: { segment: "current", quote: "cost rate" } },
              { path: "amount", value: 15, sourceRef: { segment: "current", quote: "15" } },
            ],
            maxExecutions: 1,
          }],
        }),
        currentText,
        unresolvedPriorText: "create a project named Atlas",
        requireCurrentActionSpan: true,
        writeActionNames: ["clockify_projects_rate_update"],
        catalogHash,
      });

      expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
    },
  );

  it("does not canonicalize 'my' from inside a carried member name", async () => {
    const currentText = "set project member rate to 15 for Myrtle on that project";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_rate_update",
          sourceRefs: [{ segment: "current", quote: currentText }],
          literalConstraints: [
            { path: "projectName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
            { path: "userId", value: "me", sourceRef: { segment: "current", quote: "My" } },
            { path: "rateKind", value: "HOURLY", sourceRef: { segment: "current", quote: "project member rate" } },
            { path: "amount", value: 15, sourceRef: { segment: "current", quote: "15" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText,
      unresolvedPriorText: "create a project named Atlas",
      requireCurrentActionSpan: true,
      writeActionNames: ["clockify_projects_rate_update"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("does not let a carried rate action borrow its member from another command", async () => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_rate_update",
          sourceRefs: [
            { segment: "current", quote: "make my project member rate to be 15" },
            { segment: "unresolved_prior", quote: "Atlas" },
            { segment: "current", quote: "Alice" },
            { segment: "current", quote: "15" },
          ],
          literalConstraints: [
            { path: "projectName", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
            { path: "userName", value: "Alice", sourceRef: { segment: "current", quote: "Alice" } },
            { path: "amount", value: 15, sourceRef: { segment: "current", quote: "15" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText: "add Alice to that project, then make my project member rate to be 15",
      unresolvedPriorText: "create a project named Atlas",
      requireCurrentActionSpan: true,
      writeActionNames: ["clockify_projects_rate_update"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("rejects reversing a carried project selector into the risky update value", async () => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_update",
          sourceRefs: [
            { segment: "current", quote: "rename that project" },
            { segment: "unresolved_prior", quote: "Atlas" },
            { segment: "current", quote: "Vega" },
          ],
          literalConstraints: [
            { path: "currentName", value: "Vega", sourceRef: { segment: "current", quote: "Vega" } },
            { path: "name", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText: "rename that project to Vega",
      unresolvedPriorText: "create a project named Atlas",
      requireCurrentActionSpan: true,
      writeActionNames: ["clockify_projects_update"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("does not let a create-shaped continuation authorize a carried delete command", async () => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_delete_entity",
          sourceRefs: [
            { segment: "unresolved_prior", quote: "Delete project Atlas" },
            { segment: "current", quote: "Create it" },
          ],
          literalConstraints: [
            { path: "entityType", value: "project", sourceRef: { segment: "unresolved_prior", quote: "project" } },
            { path: "name", value: "Atlas", sourceRef: { segment: "unresolved_prior", quote: "Atlas" } },
          ],
          maxExecutions: 1,
        }],
      }),
      currentText: "Create it",
      unresolvedPriorText: "Delete project Atlas.",
      requireCurrentActionSpan: true,
      writeActionNames: ["clockify_delete_entity"],
      catalogHash,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
  });

  it("supplies exact catalog-derived literal paths and reviewed aliases for a real write action", async () => {
    const capture: { messages?: ModelMessage[]; tools?: ToolDefinition[] } = {};
    const currentText = "Create a public project named Atlas.";
    await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: "Create a public project" }],
          literalConstraints: [
            { path: "name", value: "Atlas", sourceRef: { segment: "current", quote: "Atlas" } },
            { path: "isPublic", value: true, sourceRef: { segment: "current", quote: "public" } },
          ],
          maxExecutions: 1,
        }],
      }, capture),
      currentText,
      writeActionNames: ["clockify_projects_create"],
      catalogHash,
    });

    const payload = JSON.parse(capture.messages?.[1]?.content ?? "{}") as {
      writeActionContracts?: Array<Record<string, unknown>>;
    };
    expect(payload.writeActionContracts).toEqual([expect.objectContaining({
      actionName: "clockify_projects_create",
      literalControlledPaths: expect.arrayContaining(["name", "isPublic"]),
      semanticLiteralAliases: expect.arrayContaining([
        { path: "isPublic", value: false, authoredPhrases: ["non-public", "not public", "private"] },
        { path: "isPublic", value: true, authoredPhrases: ["not private", "public"] },
      ]),
    })]);
    const writeItems = ((capture.tools?.[0]?.parameters as any).properties.writeActions.items) as Record<string, any>;
    expect(writeItems.required).toContain("sourceRefs");
    expect(writeItems.required).not.toContain("sourceSpans");
    expect(writeItems.properties).toHaveProperty("sourceRefs");
    expect(writeItems.properties).not.toHaveProperty("sourceSpans");
    expect(writeItems.properties.sourceRefs.items.required).toContain("occurrence");
    expect(writeItems.properties.sourceRefs.items.properties.occurrence).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 1023,
    });
  });

  it("keeps candidate actions a filtered optional hint after the stable full-contract prefix", async () => {
    const captureRequest = async (
      currentText: string,
      candidateWriteActionNames?: readonly string[],
    ): Promise<{ raw: string; value: Record<string, unknown> }> => {
      const capture: { messages?: ModelMessage[] } = {};
      await declareIntentCapability({
        modelClient: nativeModel({ writeActions: [] }, capture),
        currentText,
        writeActionNames,
        ...(candidateWriteActionNames === undefined ? {} : { candidateWriteActionNames }),
        catalogHash,
      });
      const raw = capture.messages?.[1]?.content ?? "";
      return { raw, value: JSON.parse(raw) as Record<string, unknown> };
    };

    const narrowed = await captureRequest("Create an invoice.", ["clockify_invoices_create"]);
    expect(narrowed.value.candidateWriteActionNames).toEqual(["clockify_invoices_create"]);
    expect((narrowed.value.writeActionContracts as unknown[])).toHaveLength(writeActionNames.length);

    const empty = await captureRequest("Do nothing.", []);
    expect(empty.value.candidateWriteActionNames).toEqual([]);

    const omitted = await captureRequest("Rename a project.");
    expect(omitted.value.candidateWriteActionNames).toEqual([...writeActionNames]);

    const filtered = await captureRequest("Create an invoice.", [
      "invented_action",
      "clockify_invoices_create",
      "clockify_invoices_create",
    ]);
    expect(filtered.value.candidateWriteActionNames).toEqual(["clockify_invoices_create"]);

    const other = await captureRequest("Rename a project.", ["clockify_projects_update"]);
    const boundary = ',"candidateWriteActionNames"';
    const narrowedBoundary = narrowed.raw.indexOf(boundary);
    const otherBoundary = other.raw.indexOf(boundary);
    expect(narrowedBoundary).toBeGreaterThan(0);
    expect(otherBoundary).toBeGreaterThan(0);
    expect(narrowed.raw.slice(0, narrowedBoundary)).toBe(other.raw.slice(0, otherBoundary));
  });

  it("passes selector fail-open results through the candidate hint for recall-risk input", async () => {
    const allNames = ACTION_CATALOG.map((action) => action.name);
    const inputs = [
      "xqz pllk nnnn",
      "обриши пројекат Чукрица",
      "deactivate John, log a travel expense of 200, schedule Mary next week, and create an invoice for Acme",
    ];
    for (const currentText of inputs) {
      expect(selectActionsForMessage(currentText), currentText).toEqual(allNames);
    }
  });

  it("builds the actual declaration candidate payload from shared production selection context", async () => {
    const trustedWriteActionNames = ACTION_CATALOG
      .filter((action) => action.risks.some((risk) => risk !== "read"))
      .map((action) => action.name);
    const trustedWriteSet = new Set(trustedWriteActionNames);
    const capturePayload = async (
      currentText: string,
      unresolvedPriorText?: string,
    ): Promise<Record<string, unknown>> => {
      const selectionContext = unresolvedPriorText
        ? `${unresolvedPriorText}\n\n${currentText}`
        : currentText;
      const capture: { messages?: ModelMessage[] } = {};
      await declareIntentCapability({
        modelClient: nativeModel({ writeActions: [] }, capture),
        currentText,
        ...(unresolvedPriorText ? { unresolvedPriorText } : {}),
        writeActionNames: trustedWriteActionNames,
        candidateWriteActionNames: buildCandidateWriteActionNames(
          selectionContext,
          trustedWriteActionNames,
        ),
        catalogHash,
      });
      return JSON.parse(capture.messages?.[1]?.content ?? "") as Record<string, unknown>;
    };

    for (const currentText of [
      "xqz pllk nnnn",
      "обриши пројекат Чукрица",
      "deactivate John, log a travel expense of 200, schedule Mary next week, and create an invoice for Acme",
    ]) {
      const payload = await capturePayload(currentText);
      expect(payload.candidateWriteActionNames, currentText).toEqual(trustedWriteActionNames);
      expect((payload.candidateWriteActionNames as string[]).every((name) => trustedWriteSet.has(name))).toBe(true);
      expect(payload.candidateWriteActionNames).not.toContain("clockify_list_entities");
    }

    const prior = "Delete the tag called";
    const current = "stale";
    const payload = await capturePayload(current, prior);
    expect(payload.candidateWriteActionNames).toEqual(
      selectActionsForMessage(`${prior}\n\n${current}`).filter((name) => trustedWriteSet.has(name)),
    );
    expect(payload.segments).toEqual([
      expect.objectContaining({ source: "unresolved_prior", text: prior }),
      expect.objectContaining({ source: "current", text: current }),
    ]);
  });

  it("supplies a raw authority contract for the local assistant permission write", async () => {
    const capture: { messages?: ModelMessage[] } = {};
    await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "assistant_update_permissions",
          sourceRefs: [{ segment: "current", quote: "Set reports to read" }],
          literalConstraints: [{
            path: "groups.reports",
            value: "read",
            sourceRef: { segment: "current", quote: "read" },
          }],
          maxExecutions: 1,
        }],
      }, capture),
      currentText: "Set reports to read.",
      writeActionNames: ["assistant_update_permissions"],
      catalogHash,
    });

    const payload = JSON.parse(capture.messages?.[1]?.content ?? "{}") as {
      writeActionContracts?: Array<{ actionName?: string; literalControlledPaths?: string[] }>;
    };
    expect(payload.writeActionContracts).toEqual([expect.objectContaining({
      actionName: "assistant_update_permissions",
      literalControlledPaths: expect.arrayContaining(["groups.*"]),
    })]);
  });

  it("uses one strict JSON fallback call with the same validation and no repair", async () => {
    const currentText = "Create invoice for 125.50.";
    const span = byteSpan(currentText, "125.50");
    const provenance = vi.fn();
    let observedOptions: unknown;
    const complete = vi.fn(async (...args: unknown[]) => {
      observedOptions = args[3];
      return JSON.stringify({
      writeActions: [{
        actionName: "clockify_invoices_create",
        sourceSpans: [byteSpan(currentText, "Create invoice"), span],
        literalConstraints: [{ path: "taxPercent", value: 125.5, sourceSpan: span }],
        maxExecutions: 1,
      }],
      });
    });

    const capability = await declareIntentCapability({
      modelClient: { complete },
      currentText,
      writeActionNames,
      catalogHash,
      onProvenance: provenance,
    });

    expect(capability.mode).toBe("allow");
    expect(capability.writeActions[0]?.literalConstraints[0]?.value).toBe(125.5);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(observedOptions).toEqual({ retryTransient: false });
    expect(provenance).toHaveBeenCalledWith("provider_json");
  });

  it("canonicalizes an exact numeric-string declaration only for a trusted numeric path", async () => {
    const currentText = "Create an invoice for qwen for 1000.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_invoices_create",
          sourceRefs: [{ segment: "current", quote: "Create an invoice for qwen for 1000", occurrence: 0 }],
          literalConstraints: [{
            path: "items[].amount",
            value: "1000",
            sourceRef: { segment: "current", quote: "1000", occurrence: 0 },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_invoices_create"],
      catalogHash,
    });

    expect(capability.mode).toBe("allow");
    expect(capability.writeActions[0]?.literalConstraints).toEqual([
      expect.objectContaining({ path: "items[].amount", value: 1000 }),
    ]);
    const authority = getAction("clockify_invoices_create")?.writeAuthority;
    expect(authority).toBeDefined();
    expect(authorizeIntentWriteArguments({
      capability,
      actionName: "clockify_invoices_create",
      rawArgs: { items: [{ amount: 1000 }] },
      authority: authority!,
      catalogHash,
    })).toBeUndefined();
    expect(authorizeIntentWriteArguments({
      capability,
      actionName: "clockify_invoices_create",
      rawArgs: { items: [{ amount: "1000" }] },
      authority: authority!,
      catalogHash,
    })).toMatchObject({ ok: false, code: "intent_capability_argument_mismatch" });

    const store = createStore(":memory:");
    const persisted = store.createIntentCapability({
      id: "numeric-capability",
      workspaceId: "workspace-1",
      adminUserId: "admin-1",
      sessionId: "session-1",
      requestId: "request-1",
      authoredSource: currentText,
      capability,
    });
    expect(persisted.capability.writeActions[0]?.literalConstraints[0]?.value).toBe(1000);
    expect(persisted.capabilityHash).toBe(hashIntentCapability(capability));
    store.close();
  });

  it.each([
    ["0", 0],
    ["125.5", 125.5],
    ["125.50", 125.5],
    ["-5", -5],
    ["-5.50", -5.5],
    ["900719925474", 900_719_925_474],
  ])("canonicalizes the exact safe numeric token %s", async (token, expected) => {
    const currentText = `Create invoice for qwen for ${token}.`;
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_invoices_create",
          sourceRefs: [{ segment: "current", quote: currentText.slice(0, -1), occurrence: 0 }],
          literalConstraints: [{
            path: "items[0].amount",
            value: token,
            sourceRef: { segment: "current", quote: token, occurrence: 0 },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_invoices_create"],
      catalogHash,
    });

    expect(capability.mode).toBe("allow");
    expect(capability.writeActions[0]?.literalConstraints[0]?.value).toBe(expected);
  });

  it("pins the repaired numeric ceiling to the largest known downstream decimal scale", () => {
    expect(Number.isSafeInteger(900_719_925_474 * 10_000)).toBe(true);
    expect(Number.isSafeInteger(900_719_925_475 * 10_000)).toBe(false);
  });

  it("applies the post-scale ceiling equally to provider JSON numbers", async () => {
    const declare = (value: number) => {
      const token = String(value);
      const currentText = `Create invoice for qwen for ${token}.`;
      return declareIntentCapability({
        modelClient: nativeModel({
          writeActions: [{
            actionName: "clockify_invoices_create",
            sourceRefs: [{ segment: "current", quote: currentText.slice(0, -1), occurrence: 0 }],
            literalConstraints: [{
              path: "items[].amount",
              value,
              sourceRef: { segment: "current", quote: token, occurrence: 0 },
            }],
            maxExecutions: 1,
          }],
        }),
        currentText,
        writeActionNames: ["clockify_invoices_create"],
        catalogHash,
      });
    };

    await expect(declare(900_719_925_474)).resolves.toMatchObject({ mode: "allow" });
    await expect(declare(900_719_925_475)).resolves.toMatchObject({ mode: "deny_all_writes" });
  });

  it.each([
    ["quoted source", '"1000"', "1000"],
    ["leading whitespace", " 1000", " 1000"],
    ["trailing whitespace", "1000 ", "1000 "],
    ["positive sign", "+1000", "+1000"],
    ["exponent", "1e3", "1e3"],
    ["leading zero", "01000", "01000"],
    ["leading decimal point", ".5", ".5"],
    ["trailing decimal point", "1.", "1."],
    ["negative zero", "-0", "-0"],
    ["negative decimal zero", "-0.0", "-0.0"],
    ["currency prefix", "$1000", "$1000"],
    ["approximation prefix", "~1000", "~1000"],
    ["unit suffix", "1000USD", "1000USD"],
    ["nonfinite", "Infinity", "Infinity"],
    ["not a number", "NaN", "NaN"],
    ["unsafe integer", "9007199254740992", "9007199254740992"],
    ["first unsafe post-scale integer", "900719925475", "900719925475"],
    ["declared/source mismatch", "1000", "1000.0"],
  ])("denies numeric-string repair for %s", async (_label, quote, declared) => {
    const currentText = `Create invoice for qwen for ${quote}.`;
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_invoices_create",
          sourceRefs: [{ segment: "current", quote: currentText.slice(0, -1), occurrence: 0 }],
          literalConstraints: [{
            path: "items[].amount",
            value: declared,
            sourceRef: { segment: "current", quote, occurrence: 0 },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_invoices_create"],
      catalogHash,
    });

    expect(capability.mode).toBe("deny_all_writes");
  });

  it("denies an ambiguous numeric quote when a compatibility client omits occurrence", async () => {
    const currentText = "Create invoice for qwen for 1000 and 1000.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_invoices_create",
          sourceRefs: [{ segment: "current", quote: currentText.slice(0, -1), occurrence: 0 }],
          literalConstraints: [{
            path: "items[].amount",
            value: "1000",
            sourceRef: { segment: "current", quote: "1000" },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_invoices_create"],
      catalogHash,
    });

    expect(capability.mode).toBe("deny_all_writes");
  });

  it("uses an explicit numeric source occurrence and denies an out-of-range occurrence", async () => {
    const currentText = "Create invoice for qwen for 1000 and another for 1000.";
    const declare = (occurrence: number) => declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_invoices_create",
          sourceRefs: [{ segment: "current", quote: currentText.slice(0, -1), occurrence: 0 }],
          literalConstraints: [{
            path: "items[].amount",
            value: "1000",
            sourceRef: { segment: "current", quote: "1000", occurrence },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_invoices_create"],
      catalogHash,
    });

    await expect(declare(1)).resolves.toMatchObject({
      mode: "allow",
      writeActions: [expect.objectContaining({
        literalConstraints: [expect.objectContaining({ value: 1000 })],
      })],
    });
    await expect(declare(2)).resolves.toMatchObject({ mode: "deny_all_writes" });
  });

  it("preserves the same authored token as a string on a trusted string path", async () => {
    const currentText = "Create invoice for client 1000.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_invoices_create",
          sourceRefs: [{ segment: "current", quote: currentText.slice(0, -1), occurrence: 0 }],
          literalConstraints: [{
            path: "clientName",
            value: "1000",
            sourceRef: { segment: "current", quote: "1000", occurrence: 0 },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_invoices_create"],
      catalogHash,
    });

    expect(capability.mode).toBe("allow");
    expect(capability.writeActions[0]?.literalConstraints[0]?.value).toBe("1000");
  });

  it("does not canonicalize a string-or-number union path and denies unknown or structured numeric paths", async () => {
    const mixedText = "Set custom field value to 1000.";
    const mixed = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_custom_fields_set_value_project",
          sourceRefs: [{ segment: "current", quote: mixedText.slice(0, -1), occurrence: 0 }],
          literalConstraints: [{
            path: "value",
            value: "1000",
            sourceRef: { segment: "current", quote: "1000", occurrence: 0 },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText: mixedText,
      writeActionNames: ["clockify_custom_fields_set_value_project"],
      catalogHash,
    });
    expect(mixed.mode).toBe("allow");
    expect(mixed.writeActions[0]?.literalConstraints[0]?.value).toBe("1000");

    for (const constraint of [
      {
        path: "items[].unknown",
        value: "1000",
        sourceRef: { segment: "current" as const, quote: "1000", occurrence: 0 },
      },
      {
        path: "items[].amount",
        value: { amount: 1000 },
        sourceRef: { segment: "current" as const, quote: '{"amount":1000}', occurrence: 0 },
      },
    ]) {
      const currentText = constraint.path.endsWith("unknown")
        ? "Create invoice for qwen for 1000."
        : 'Create invoice for qwen for {"amount":1000}.';
      const denied = await declareIntentCapability({
        modelClient: nativeModel({
          writeActions: [{
            actionName: "clockify_invoices_create",
            sourceRefs: [{ segment: "current", quote: currentText.slice(0, -1), occurrence: 0 }],
            literalConstraints: [constraint],
            maxExecutions: 1,
          }],
        }),
        currentText,
        writeActionNames: ["clockify_invoices_create"],
        catalogHash,
      });
      expect(denied.mode, constraint.path).toBe("deny_all_writes");
    }
  });

  it("canonicalizes an exact negative balance adjustment on its trusted numeric path", async () => {
    const currentText = "Adjust the time-off balance by -5.";
    const capability = await declareIntentCapability({
      modelClient: nativeModel({
        writeActions: [{
          actionName: "clockify_time_off_balance_update",
          sourceRefs: [{ segment: "current", quote: currentText.slice(0, -1), occurrence: 0 }],
          literalConstraints: [{
            path: "value",
            value: "-5",
            sourceRef: { segment: "current", quote: "-5", occurrence: 0 },
          }],
          maxExecutions: 1,
        }],
      }),
      currentText,
      writeActionNames: ["clockify_time_off_balance_update"],
      catalogHash,
    });

    expect(capability.mode).toBe("allow");
    expect(capability.writeActions[0]?.literalConstraints[0]?.value).toBe(-5);
  });

  it("publishes numeric scalar paths from trusted public schema metadata", async () => {
    const capture: { messages?: ModelMessage[] } = {};
    await declareIntentCapability({
      modelClient: nativeModel({ writeActions: [] }, capture),
      currentText: "Do nothing.",
      writeActionNames: ["clockify_invoices_create"],
      catalogHash,
    });
    const payload = JSON.parse(capture.messages?.[1]?.content ?? "") as {
      writeActionContracts: Array<{ numericLiteralPaths: string[] }>;
    };

    expect(payload.writeActionContracts[0]?.numericLiteralPaths).toEqual(expect.arrayContaining([
      "items[].amount",
      "items[].quantity",
      "taxPercent",
    ]));
    expect(payload.writeActionContracts[0]?.numericLiteralPaths).not.toContain("number");
    expect(payload.writeActionContracts[0]?.numericLiteralPaths).not.toContain("items[].description");
  });

  it("tells the declaration provider to emit JSON numbers for trusted numeric paths", async () => {
    const capture: { messages?: ModelMessage[] } = {};
    await declareIntentCapability({
      modelClient: nativeModel({ writeActions: [] }, capture),
      currentText: "Do nothing.",
      writeActionNames: ["clockify_invoices_create"],
      catalogHash,
    });
    expect(capture.messages?.[0]?.content).toContain(
      "paths listed in numericLiteralPaths, emit a JSON number rather than a quoted numeric string",
    );
  });

  it("passes the exact AbortSignal through native and JSON provider calls", async () => {
    const controller = new AbortController();
    const nativeCapture: { signal?: AbortSignal } = {};
    const currentText = "Rename to Atlas";
    const payload = declaration("clockify_projects_update", byteSpan(currentText, "Atlas"));
    const jsonSignal: { value?: AbortSignal } = {};
    const jsonModel: ModelClient = {
      complete: vi.fn(async (_messages, _usage, signal) => {
        jsonSignal.value = signal;
        return JSON.stringify(payload);
      }),
    };

    await declareIntentCapability({
      modelClient: nativeModel(payload, nativeCapture),
      currentText,
      writeActionNames,
      catalogHash,
      signal: controller.signal,
    });
    await declareIntentCapability({
      modelClient: jsonModel,
      currentText,
      writeActionNames,
      catalogHash,
      signal: controller.signal,
    });

    expect(nativeCapture.signal).toBe(controller.signal);
    expect(jsonSignal.value).toBe(controller.signal);
  });

  it.each([
    ["provider failure", async () => { throw new Error("provider unavailable"); }],
    ["malformed JSON", async () => "{not-json"],
    ["invented action", async () => JSON.stringify(declaration("clockify_users_delete", { startByte: 0, endByte: 6, text: "Rename" }))],
    ["invented literal", async () => JSON.stringify(declaration("clockify_projects_update", { startByte: 0, endByte: 6, text: "Vega" }))],
  ])("persists a deny-all-writes-shaped result after %s", async (_label, complete) => {
    const capability = await declareIntentCapability({
      modelClient: { complete },
      currentText: "Rename the project to Atlas.",
      writeActionNames,
      catalogHash,
    });

    expect(capability).toMatchObject({
      version: 1,
      mode: "deny_all_writes",
      catalogHash,
      writeActions: [],
    });
  });

  it.each([
    ["inside a UTF-8 code point", { startByte: 1, endByte: 3, text: "Ž" }],
    ["outside the request", { startByte: 0, endByte: 999, text: "Ž" }],
    ["across authored segments", { startByte: 2, endByte: 5, text: "o\nБ" }],
  ])("denies malformed source spans: %s", async (_label, sourceSpan) => {
    const capability = await declareIntentCapability({
      modelClient: nativeModel(declaration("clockify_projects_update", sourceSpan)),
      unresolvedPriorText: "Žao",
      currentText: "Бео",
      writeActionNames,
      catalogHash,
    });

    expect(capability.mode).toBe("deny_all_writes");
  });

  it("normalizes an exact zero-tool native completion to a local empty declaration", async () => {
    const provenance = vi.fn();
    const complete = vi.fn(async () => "must not run");
    const completeWithTools = vi.fn(async () => ({
      text: "There is no write action to declare.",
      toolCalls: [],
    }));

    const capability = await declareIntentCapability({
      modelClient: { complete, completeWithTools },
      currentText: "How many projects are there?",
      writeActionNames,
      catalogHash,
      onProvenance: provenance,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "no_write_intent" });
    expect(provenance).toHaveBeenCalledOnce();
    expect(provenance).toHaveBeenCalledWith("local_empty_zero_tool");
    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ["explicit safe write", "Create project Atlas", undefined, "No tool needed."],
    ["risky write", "Delete project Acme", undefined, '{"writeActions":[{"actionName":"clockify_delete_entity"}]}'],
    ["approve all", "Approve all pending timesheets", undefined, "I can approve everything directly."],
    ["mixed prior/current write", "Yes, do it", "Create project Atlas", "The prior request authorizes this."],
  ])("never infers grants from zero-tool text or authored context: %s", async (
    _label,
    currentText,
    unresolvedPriorText,
    providerText,
  ) => {
    const completeWithTools = vi.fn(async () => ({ text: providerText, toolCalls: [], finishReason: "stop" }));
    const capability = await declareIntentCapability({
      modelClient: { complete: vi.fn(async () => "must not run"), completeWithTools },
      currentText,
      ...(unresolvedPriorText ? { unresolvedPriorText } : {}),
      writeActionNames,
      catalogHash,
    });

    expect(capability).toMatchObject({
      mode: "deny_all_writes",
      reason: "no_write_intent",
      writeActions: [],
    });
    expect(completeWithTools).toHaveBeenCalledTimes(1);
  });

  it("does not normalize a truncated zero-tool completion", async () => {
    const provenance = vi.fn();
    const capability = await declareIntentCapability({
      modelClient: {
        complete: vi.fn(async () => "must not run"),
        completeWithTools: vi.fn(async () => ({
          text: '{"writeActions":[]}',
          toolCalls: [],
          finishReason: "length",
        })),
      },
      currentText: "Create a project named Atlas",
      writeActionNames,
      catalogHash,
      onProvenance: provenance,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
    expect(provenance).toHaveBeenCalledWith("invalid");
  });

  it("rejects a zero-tool completion that contradictorily reports tool_calls termination", async () => {
    const provenance = vi.fn();
    const capability = await declareIntentCapability({
      modelClient: {
        complete: vi.fn(async () => "must not run"),
        completeWithTools: vi.fn(async () => ({
          text: "",
          toolCalls: [],
          finishReason: "tool_calls",
        })),
      },
      currentText: "Create project Atlas",
      writeActionNames,
      catalogHash,
      onProvenance: provenance,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
    expect(provenance).toHaveBeenCalledWith("invalid");
  });

  it("accepts one valid declaration tool call with tool_calls termination", async () => {
    const currentText = "Rename to Atlas";
    const atlas = byteSpan(currentText, "Atlas");
    const capability = await declareIntentCapability({
      modelClient: {
        complete: vi.fn(async () => "must not run"),
        completeWithTools: vi.fn(async () => ({
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "declare-1",
            name: DECLARE_INTENT_TOOL_NAME,
            arguments: declaration("clockify_projects_update", atlas),
          }],
        })),
      },
      currentText,
      writeActionNames,
      catalogHash,
    });

    expect(capability.mode).toBe("allow");
  });

  it("rejects a truncated one-tool declaration before validating its partial arguments", async () => {
    const currentText = "Rename to Atlas and archive the project";
    const atlas = byteSpan(currentText, "Atlas");
    const provenance = vi.fn();
    const capability = await declareIntentCapability({
      modelClient: {
        complete: vi.fn(async () => "must not run"),
        completeWithTools: vi.fn(async () => ({
          text: "",
          finishReason: "length",
          toolCalls: [{
            id: "partial-1",
            name: DECLARE_INTENT_TOOL_NAME,
            arguments: declaration("clockify_projects_update", atlas),
          }],
        })),
      },
      currentText,
      writeActionNames,
      catalogHash,
      onProvenance: provenance,
    });

    expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
    expect(provenance).toHaveBeenCalledWith("invalid");
  });

  it("denies multiple/wrong native declaration calls without falling back or retrying", async () => {
    const complete = vi.fn(async () => "must not run");
    const outputs = [
      {
        text: "",
        toolCalls: [
          { id: "1", name: DECLARE_INTENT_TOOL_NAME, arguments: { writeActions: [] } },
          { id: "2", name: DECLARE_INTENT_TOOL_NAME, arguments: { writeActions: [] } },
        ],
      },
      { text: "", toolCalls: [{ id: "1", name: "some_other_tool", arguments: { writeActions: [] } }] },
    ];

    for (const output of outputs) {
      const provenance = vi.fn();
      const completeWithTools = vi.fn(async () => output);
      const capability = await declareIntentCapability({
        modelClient: { complete, completeWithTools },
        currentText: "Rename to Atlas",
        writeActionNames,
        catalogHash,
        onProvenance: provenance,
      });
      expect(capability).toMatchObject({ mode: "deny_all_writes", reason: "declaration_invalid" });
      expect(provenance).toHaveBeenCalledWith("invalid");
      expect(completeWithTools).toHaveBeenCalledTimes(1);
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps every read while preventing a full-catalog fallback from reintroducing undeclared writes", async () => {
    const entries: ActionCatalogEntry[] = [
      { name: "clockify_status", description: "Read", featureGroup: "workspace_settings", risks: ["read"], args: "{}" },
      { name: "clockify_projects_update", description: "Write", featureGroup: "work_structure", risks: ["high_risk_write"], args: "{}" },
      { name: "clockify_invoices_create", description: "Write", featureGroup: "invoices", risks: ["billing"], args: "{}" },
    ];
    const currentText = "Rename to Atlas";
    const allow = await declareIntentCapability({
      modelClient: nativeModel(declaration("clockify_projects_update", byteSpan(currentText, "Atlas"))),
      currentText,
      writeActionNames,
      catalogHash,
    });
    const deny = await declareIntentCapability({
      modelClient: { complete: vi.fn(async () => "bad") },
      currentText,
      writeActionNames,
      catalogHash,
    });

    expect(filterCatalogByIntentCapability(entries, allow).map((entry) => entry.name)).toEqual([
      "clockify_status",
      "clockify_projects_update",
    ]);
    expect(filterCatalogByIntentCapability(entries, deny).map((entry) => entry.name)).toEqual([
      "clockify_status",
    ]);
  });
});
