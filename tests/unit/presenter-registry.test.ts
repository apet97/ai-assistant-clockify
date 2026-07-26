import { describe, expect, it } from "vitest";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { ActionDefinition } from "../../src/harness/action.js";
import {
  findPresenterCoverageErrors,
  presentedFactsFromPreparedWrite,
  requireCompletePresenterCoverage,
} from "../../src/assistant-v2/presentation/presenter-registry.js";
import {
  assertPreviewTerminalFactParity,
  presentPendingWriteConfirmation,
} from "../../src/services/result-presentation-service.js";
import { presentedResultSchema } from "../../src/assistant-v2/presentation/presented-result.js";
import type { JsonValue } from "../../src/harness/prepared-write-presentation.js";

/**
 * T15-B: the presenter registry. `tests/unit/v2-prepared-write.test.ts`
 * already covers Task 11's own formatter/presenter/provenance validation
 * (duplicate registrations, provenance mismatches, the 22-fact limit, the
 * public 24-fact envelope order) — this file does not duplicate that. It
 * covers only what T15-B adds: the exactly-one-presenter-per-catalog-action
 * assertion `validateCatalogPresentationRegistries` does not itself make,
 * the mechanical fact adapter, and the preview/terminal parity function.
 */

function fixtureAction(overrides: Partial<ActionDefinition>): ActionDefinition {
  return {
    name: "clockify_fixture_action",
    apiExposure: "api",
    presentation: { presenterId: "clockify_fixture_action", version: 1 },
    ...overrides,
  } as unknown as ActionDefinition;
}

describe("T15-B: exactly one presenter for every model-API action", () => {
  it("the REAL MODEL_API_ACTION_CATALOG (127 today) has complete coverage", () => {
    expect(() => requireCompletePresenterCoverage(MODEL_API_ACTION_CATALOG.actions)).not.toThrow();
    const apiActions = MODEL_API_ACTION_CATALOG.actions.filter((a) => a.apiExposure === "api");
    expect(apiActions.length).toBeGreaterThan(0);
    expect(findPresenterCoverageErrors(MODEL_API_ACTION_CATALOG.actions)).toEqual([]);
  });

  it("fails on a missing presenter for an api-exposed action", () => {
    const actions = [fixtureAction({ name: "clockify_missing", presentation: undefined })];
    const errors = findPresenterCoverageErrors(actions);
    expect(errors).toEqual([{ code: "missing_presenter", actionName: "clockify_missing" }]);
    expect(() => requireCompletePresenterCoverage(actions)).toThrow("missing_presenter:clockify_missing");
  });

  it("fails on a duplicate presenterId across two actions", () => {
    // Reuse a REAL, already-registered presenterId from the catalog so this
    // isolates the duplicate check from the separate unregistered-presenter
    // check exercised above.
    const realPresenterId = "clockify_tags_create";
    const actions = [
      fixtureAction({ name: "clockify_a", presentation: { presenterId: realPresenterId, version: 1 } }),
      fixtureAction({ name: "clockify_b", presentation: { presenterId: realPresenterId, version: 1 } }),
    ];
    const errors = findPresenterCoverageErrors(actions);
    expect(errors).toEqual([{ code: "duplicate_presenter", actionName: "clockify_b", presenterId: realPresenterId }]);
  });

  it("fails on a presenterId that was never registered", () => {
    const actions = [
      fixtureAction({ name: "clockify_unregistered", presentation: { presenterId: "never_registered_id", version: 1 } }),
    ];
    const errors = findPresenterCoverageErrors(actions);
    expect(errors).toEqual([
      { code: "unregistered_presenter", actionName: "clockify_unregistered", presenterId: "never_registered_id" },
    ]);
  });

  it("skips non-api-exposed actions (composite/generic/local never need a v2 presenter)", () => {
    const actions = [
      fixtureAction({ name: "clockify_composite", apiExposure: "composite", presentation: undefined }),
      fixtureAction({ name: "clockify_generic", apiExposure: "generic", presentation: undefined }),
      fixtureAction({ name: "clockify_local", apiExposure: "local", presentation: undefined }),
    ];
    expect(findPresenterCoverageErrors(actions)).toEqual([]);
  });
});

describe("T15-B: presentedFactsFromPreparedWrite — the mechanical adapter", () => {
  it("maps material facts + endpoint + reversibility, unchanged from toPublicPresentationFacts", () => {
    const facts = presentedFactsFromPreparedWrite({
      title: "Create project Atlas",
      facts: [{ path: "/name", label: "Name", value: "Atlas", provenance: { source: "model_inference" } }],
      warnings: [],
      reversibility: { reversible: true, explanation: "Creating this can be undone." },
      endpoint: { host: "api", method: "POST", path: "/workspaces/{workspaceId}/projects" },
    });
    expect(facts).toEqual([
      { label: "Name", value: "Atlas" },
      { label: "API endpoint", value: "POST api/workspaces/{workspaceId}/projects" },
      { label: "Reversibility", value: "Creating this can be undone." },
    ]);
    // Every produced fact must satisfy the strict presentedResultSchema on its own.
    expect(() =>
      presentedResultSchema.parse({
        status: "pending_confirmation",
        title: "Create project Atlas",
        summary: "Creating this can be undone.",
        facts,
        warnings: [],
        references: [],
      }),
    ).not.toThrow();
  });

  it("throws presentation_limit_exceeded rather than silently truncating an oversized fact list", () => {
    const oversizedFacts = Array.from({ length: 30 }, (_, i) => ({
      path: `/f${i}`,
      label: `f${i}`,
      value: "v",
      provenance: { source: "model_inference" as const },
    }));
    expect(() =>
      presentedFactsFromPreparedWrite({
        title: "x",
        facts: oversizedFacts,
        warnings: [],
        reversibility: { reversible: true, explanation: "x" },
        endpoint: { host: "api", method: "POST", path: "/x" },
      }),
    ).toThrow(/presentation_limit_exceeded/);
  });
});

describe("T15-B: presentPendingWriteConfirmation — a real catalog action end to end", () => {
  it("renders a pending_confirmation PresentedResult from a real registered presenter", () => {
    const action = MODEL_API_ACTION_CATALOG.actions.find(
      (a) => a.apiExposure === "api" && a.name === "clockify_tags_create",
    );
    expect(action).toBeDefined();
    const result = presentPendingWriteConfirmation({
      definition: action!,
      normalizedOperation: { body: { name: "Design" } },
      fieldProvenance: { "/body/name": { source: "model_inference" } },
      resolvedTargets: [],
      serverDefaults: [],
    });
    expect(result.status).toBe("pending_confirmation");
    expect(() => presentedResultSchema.parse(result)).not.toThrow();
  });

  it("throws not_presentable for an action that is not api-exposed", () => {
    expect(() =>
      presentPendingWriteConfirmation({
        definition: fixtureAction({ apiExposure: "composite", presentation: undefined }),
        normalizedOperation: {},
        fieldProvenance: {},
        resolvedTargets: [],
        serverDefaults: [],
      }),
    ).toThrow(/not_presentable/);
  });
});

describe("T15-B: assertPreviewTerminalFactParity — the preview/terminal pointer-mismatch check", () => {
  const preview = [
    { label: "Name", value: "Atlas" },
    { label: "Client", value: "Acme Corp" },
  ];

  it("passes when every confirmed fact survives unchanged, even with added terminal-only facts", () => {
    const terminal = [...preview, { label: "Created at", value: "2026-07-26T00:00:00.000Z" }];
    expect(() => assertPreviewTerminalFactParity(preview, terminal)).not.toThrow();
  });

  it("throws confirmed_fact_dropped when a preview fact is missing from the terminal result", () => {
    const terminal = [{ label: "Name", value: "Atlas" }];
    expect(() => assertPreviewTerminalFactParity(preview, terminal)).toThrow("confirmed_fact_dropped:Client");
  });

  it("throws confirmed_fact_changed when a preview fact's value drifts at terminal render", () => {
    const terminal = [{ label: "Name", value: "Atlas" }, { label: "Client", value: "Different Corp" }];
    expect(() => assertPreviewTerminalFactParity(preview, terminal)).toThrow("confirmed_fact_changed:Client");
  });
});

/**
 * T15-D: write preview-to-terminal fact parity, one representative real
 * action per domain family (structure → time → reporting → invoices →
 * expenses → users → leave, the plan's own order) proving the mechanism —
 * `presentPendingWriteConfirmation` + `assertPreviewTerminalFactParity` — is
 * genuinely mechanical and not per-domain-authored. Each case renders a real
 * preview from the real registered presenter, then proves a terminal render
 * that keeps every confirmed value (plus response-only additions) passes,
 * and one that drops or alters a confirmed value fails.
 */
describe("T15-D: write preview-to-terminal fact parity across domain families", () => {
  const cases: Array<{
    family: string;
    actionName: string;
    normalizedOperation: Record<string, JsonValue>;
    fieldProvenance: Record<string, { source: "model_inference" }>;
  }> = [
    {
      family: "structure",
      actionName: "clockify_clients_create_base",
      normalizedOperation: { body: { name: "Acme Corp" } },
      fieldProvenance: { "/body/name": { source: "model_inference" } },
    },
    {
      family: "time",
      actionName: "clockify_entries_create",
      normalizedOperation: { start: "2026-07-26T09:00:00.000Z" },
      fieldProvenance: { "/start": { source: "model_inference" } },
    },
    {
      family: "reporting",
      actionName: "clockify_webhooks_create",
      normalizedOperation: { name: "Deploy hook", url: "https://example.com/hook", webhookEvent: "NEW_TIME_ENTRY" },
      fieldProvenance: {
        "/name": { source: "model_inference" },
        "/url": { source: "model_inference" },
        "/webhookEvent": { source: "model_inference" },
      },
    },
    {
      family: "invoices",
      actionName: "clockify_invoices_create_base",
      normalizedOperation: {
        base: { clientId: "abc123", number: "INV-1", issuedDate: "2026-07-26", dueDate: "2026-08-26", currency: "USD" },
      },
      fieldProvenance: {
        "/base/clientId": { source: "model_inference" },
        "/base/number": { source: "model_inference" },
        "/base/issuedDate": { source: "model_inference" },
        "/base/dueDate": { source: "model_inference" },
        "/base/currency": { source: "model_inference" },
      },
    },
    {
      family: "expenses",
      actionName: "clockify_custom_fields_create",
      normalizedOperation: { name: "Priority", fieldType: "TXT" },
      fieldProvenance: { "/name": { source: "model_inference" }, "/fieldType": { source: "model_inference" } },
    },
    {
      family: "users",
      actionName: "clockify_projects_memberships_replace",
      normalizedOperation: { id: "project1", memberships: [{ userId: "user1" }] },
      fieldProvenance: { "/id": { source: "model_inference" }, "/memberships/0/userId": { source: "model_inference" } },
    },
    {
      family: "leave",
      actionName: "clockify_approvals_submit",
      normalizedOperation: { period: "WEEK", periodStart: "2026-07-20T00:00:00.000Z" },
      fieldProvenance: {
        "/period": { source: "model_inference" },
        "/periodStart": { source: "model_inference" },
      },
    },
  ];

  it.each(cases)("$family: $actionName — a real preview renders and survives an unchanged terminal render", (testCase) => {
    const action = MODEL_API_ACTION_CATALOG.actions.find((a) => a.name === testCase.actionName);
    expect(action, `${testCase.actionName} must exist in MODEL_API_ACTION_CATALOG`).toBeDefined();
    const preview = presentPendingWriteConfirmation({
      definition: action!,
      normalizedOperation: testCase.normalizedOperation,
      fieldProvenance: testCase.fieldProvenance,
      resolvedTargets: [],
      serverDefaults: [],
    });
    expect(() => presentedResultSchema.parse(preview)).not.toThrow();
    expect(preview.facts.length).toBeGreaterThan(0);

    // A terminal render that echoes every preview fact unchanged, plus one
    // response-only addition, must pass.
    const terminalFacts = [...preview.facts, { label: "Confirmed at", value: "2026-07-26T00:00:00.000Z" }];
    expect(() => assertPreviewTerminalFactParity(preview.facts, terminalFacts)).not.toThrow();

    // A terminal render that drops the FIRST confirmed material fact must fail.
    const droppedFirstFact = terminalFacts.filter((f) => f.label !== preview.facts[0]!.label);
    expect(() => assertPreviewTerminalFactParity(preview.facts, droppedFirstFact)).toThrow("confirmed_fact_dropped");

    // A terminal render that alters the FIRST confirmed material fact's value must fail.
    const alteredFirstFact = terminalFacts.map((f) =>
      f.label === preview.facts[0]!.label ? { ...f, value: `${f.value}-tampered` } : f,
    );
    expect(() => assertPreviewTerminalFactParity(preview.facts, alteredFirstFact)).toThrow("confirmed_fact_changed");
  });
});
