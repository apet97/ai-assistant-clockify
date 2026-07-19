import { describe, expect, it, vi } from "vitest";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { runAgenticCase } from "../../scripts/eval-agentic.js";
import {
  AGENTIC_CASES,
  RELEASE_INTENT_PATH_ACTION,
  RELEASE_INTENT_PATH_CASE_ID,
  RELEASE_INTENT_PATH_MESSAGE,
  RELEASE_INTENT_PATH_PROJECT_NAME,
} from "../../scripts/eval/agentic-cases.js";

function fullPathModel(projectIsPublic: boolean, options: {
  omitVisibility?: boolean;
  omitOccurrence?: boolean;
  repeatWrite?: boolean;
  finalText?: string;
} = {}): ModelClient {
  let mainCalls = 0;
  return {
    complete: vi.fn(async () => ""),
    completeWithTools: vi.fn(async (_messages, tools) => {
      if (tools.length === 1 && tools[0]?.name === "declare_intent_capability") {
        const sourceRef = (quote: string) => ({
          segment: "current" as const,
          quote,
          ...(!options.omitOccurrence ? { occurrence: 0 } : {}),
        });
        const action = sourceRef("Create a public project");
        const visibility = sourceRef("public");
        const name = sourceRef(RELEASE_INTENT_PATH_PROJECT_NAME);
        return {
          text: "",
          toolCalls: [{
            id: "declare-1",
            name: "declare_intent_capability",
            arguments: {
              writeActions: [{
                actionName: RELEASE_INTENT_PATH_ACTION,
                sourceRefs: [action, visibility, name],
                literalConstraints: [
                  { path: "name", value: name.quote, sourceRef: name },
                  ...(!options.omitVisibility
                    ? [{ path: "isPublic", value: true, sourceRef: visibility }]
                    : []),
                ],
                maxExecutions: 1,
              }],
            },
          }],
        };
      }
      mainCalls += 1;
      return mainCalls === 1 || (options.repeatWrite && mainCalls === 2)
        ? {
            text: "",
            toolCalls: [{
              id: "create-1",
              name: RELEASE_INTENT_PATH_ACTION,
              arguments: {
                name: RELEASE_INTENT_PATH_PROJECT_NAME,
                ...(!options.omitVisibility ? { isPublic: projectIsPublic } : {}),
              },
            }],
          }
        : { text: options.finalText ?? "Project created.", toolCalls: [] };
    }),
  };
}

describe("DeepSeek release full intent-capability path", () => {
  const releaseCase = AGENTIC_CASES.find((candidate) => candidate.id === RELEASE_INTENT_PATH_CASE_ID);

  it("runs the exact live request through declaration, raw authority, and one fake safe write", async () => {
    expect(releaseCase).toBeDefined();
    const run = await runAgenticCase(fullPathModel(true), releaseCase!, true, false);

    expect(releaseCase!.check(run.outcome)).toEqual([]);
    expect(run).toMatchObject({
      writeActionCount: 1,
      intentDeclarationCalls: 1,
      intentDeclarationContract: "quote_refs_v1",
      intentCapabilityMode: "allow",
      intentCapabilityActionBound: true,
      intentAuthorityChecks: 1,
      intentAuthorityDenials: 0,
      intentCapabilityBindCount: 1,
      intentCapabilityConsumeCount: 1,
      intentCapabilityConsumeDenials: 0,
    });
    expect(run.outcome.fake.counts.createProjectAtomic).toBe(1);
    expect(run.intentCapabilityLiteralsExact).toBe(true);
    expect(run.intentWriteArgumentsExact).toBe(true);
  });

  it("binds both same-action operations but atomically denies the second capability consumption", async () => {
    expect(releaseCase).toBeDefined();
    const run = await runAgenticCase(
      fullPathModel(true, { repeatWrite: true }),
      releaseCase!,
      true,
      false,
    );

    expect(run).toMatchObject({
      writeActionCount: 2,
      intentCapabilityBindCount: 2,
      intentCapabilityConsumeCount: 2,
      intentCapabilityConsumeDenials: 1,
      intentHostMutationCount: 1,
    });
    expect(run.outcome.fake.counts.createProjectAtomic).toBe(1);
    expect(run.outcome.fake.state.projects.filter((project) =>
      project.name === RELEASE_INTENT_PATH_PROJECT_NAME)).toHaveLength(1);
  });

  it("blocks a model visibility flip before the fake host", async () => {
    expect(releaseCase).toBeDefined();
    const run = await runAgenticCase(fullPathModel(false), releaseCase!, true, false);

    expect(run.intentAuthorityChecks).toBe(1);
    expect(run.intentAuthorityDenials).toBe(1);
    expect(run.outcome.fake.counts.createProjectAtomic ?? 0).toBe(0);
    expect(releaseCase!.check(run.outcome)).not.toEqual([]);
  });

  it("marks quote references without an explicit occurrence as legacy evidence", async () => {
    expect(releaseCase).toBeDefined();
    const run = await runAgenticCase(
      fullPathModel(true, { omitOccurrence: true }),
      releaseCase!,
      true,
      false,
    );

    expect(run.intentDeclarationContract).toBe("invalid_or_legacy");
  });

  it("fails when visibility is omitted from both the capability and fake mutation", async () => {
    expect(releaseCase).toBeDefined();
    const run = await runAgenticCase(
      fullPathModel(true, { omitVisibility: true }),
      releaseCase!,
      true,
      false,
    );

    expect(run.intentCapabilityLiteralsExact).toBe(false);
    expect(run.intentWriteArgumentsExact).toBe(false);
    expect(releaseCase!.check(run.outcome)).not.toEqual([]);
  });

  it("fails when provider narration instructs typed confirmation", async () => {
    expect(releaseCase).toBeDefined();
    const run = await runAgenticCase(
      fullPathModel(true, { finalText: "Type yes to confirm." }),
      releaseCase!,
      true,
      false,
    );

    expect(releaseCase!.check(run.outcome)).not.toEqual([]);
  });
});
