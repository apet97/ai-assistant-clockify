import { describe, expect, it } from "vitest";

import { buildApiOperationIndex } from "../../src/assistant-v2/discovery/api-index.js";
import {
  scoreIndexedOperation,
  searchApiOperations,
} from "../../src/assistant-v2/discovery/api-search.js";
import { normalizeSearchText, tokenizeSearchText, trigramJaccardSimilarity } from "../../src/assistant-v2/discovery/api-text.js";
import { LOCAL_ASSISTANT_TOOL_NAMES, MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";

const index = buildApiOperationIndex(MODEL_API_ACTION_CATALOG);

function namesFor(
  query: string,
  options: {
    authClass?: "addon" | "api_key";
    access?: "read" | "write" | "any";
    groups?: Array<"work_structure" | "invoices" | "time_tracking">;
    limit?: number;
  } = {},
): string[] {
  const result = searchApiOperations(
    index,
    { query, access: options.access, groups: options.groups, limit: options.limit },
    options.authClass ?? "addon",
  );
  if (result.kind === "notice") return [];
  return result.operations.map((operation) => operation.toolName);
}

describe("api-text", () => {
  it("normalizes with NFKC and lowercase", () => {
    expect(normalizeSearchText("ＡＢＣ")).toBe("abc");
    expect(normalizeSearchText("ProjecT")).toBe("project");
  });

  it("tokenizes Unicode letters and numbers generically", () => {
    expect(tokenizeSearchText("list projets 2024")).toEqual(["list", "projets", "2024"]);
    expect(tokenizeSearchText("Računi")).toEqual(["računi"]);
  });

  it("computes code-point trigram Jaccard", () => {
    expect(trigramJaccardSimilarity("projects", "projecrs")).toBeGreaterThan(0.34);
  });
});

describe("searchApiOperations", () => {
  it("finds canonical project list terms", () => {
    const names = namesFor("projects list");
    expect(names).toContain("clockify_projects_list");
    expect(names[0]).toBe("clockify_projects_list");
  });

  it("finds trusted-description paraphrases", () => {
    const names = namesFor("list projects optionally filtered by name");
    expect(names).toContain("clockify_projects_list");
  });

  it("tolerates a one-character spelling error via trigram similarity", () => {
    const names = namesFor("projecrs list");
    expect(names).toContain("clockify_projects_list");
  });

  it("applies access filters before scoring", () => {
    const readNames = namesFor("project", { access: "read" });
    const writeNames = namesFor("project", { access: "write" });
    expect(readNames.every((name) => {
      const operation = index.operations.find((entry) => entry.toolName === name);
      return operation?.access === "read";
    })).toBe(true);
    expect(writeNames.every((name) => {
      const operation = index.operations.find((entry) => entry.toolName === name);
      return operation?.access === "write";
    })).toBe(true);
    expect(readNames).not.toEqual(writeNames);
  });

  it("applies feature-group filters before scoring", () => {
    const names = namesFor("invoice", { groups: ["invoices"] });
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => {
      const operation = index.operations.find((entry) => entry.toolName === name);
      return operation?.featureGroup === "invoices";
    })).toBe(true);
  });

  it("returns stable tie order by operation id then tool name", () => {
    const first = namesFor("getProjects");
    const second = namesFor("getProjects");
    expect(first).toEqual(second);
    if (first.length >= 2) {
      const left = index.operations.find((entry) => entry.toolName === first[0])!;
      const right = index.operations.find((entry) => entry.toolName === first[1])!;
      expect(left.operationId.localeCompare(right.operationId)).toBeLessThanOrEqual(0);
    }
  });

  it("returns no operations for whitespace-only queries", () => {
    const result = searchApiOperations(index, { query: "   " }, "addon");
    expect(result.kind).toBe("matches");
    if (result.kind === "matches") {
      expect(result.operations).toEqual([]);
    }
  });

  it("respects exact limit boundaries and caps at 12", () => {
    const three = searchApiOperations(index, { query: "clockify", limit: 3 }, "addon");
    const twelve = searchApiOperations(index, { query: "clockify", limit: 12 }, "addon");
    if (three.kind === "matches" && twelve.kind === "matches") {
      expect(three.operations).toHaveLength(3);
      expect(twelve.operations.length).toBeLessThanOrEqual(12);
    }
  });

  it("does not return destructive writes for a read-oriented project query", () => {
    const names = namesFor("list projects", { access: "read" });
    expect(names).toContain("clockify_projects_list");
    expect(names).not.toContain("clockify_projects_delete_archived");
  });

  it("filters unavailable addon operations before scoring and emits a notice when they would match", () => {
    const result = searchApiOperations(index, { query: "webhooks" }, "addon");
    expect(result.kind).toBe("notice");
    if (result.kind === "notice") {
      expect(result.code).toBe("no_available_operation_for_auth_class");
      expect(result.authClass).toBe("addon");
    }
  });

  it("returns unavailable matches for api_key auth when addon blocks them", () => {
    const names = namesFor("clockify_custom_fields_create", { authClass: "api_key" });
    expect(names).toContain("clockify_custom_fields_create");
  });

  it("never returns local assistant actions", () => {
    const names = namesFor("permissions recent outcomes undo assistant");
    for (const name of names) {
      expect(LOCAL_ASSISTANT_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it("preserves Unicode data tokens through NFKC-normalized search", () => {
    const names = namesFor("ｐｒｏｊｅｃｔｓ list");
    expect(names).toContain("clockify_projects_list");
  });
});

describe("scoreIndexedOperation", () => {
  it("requires an exact token match for queries shorter than three code points", () => {
    const operation = index.operations.find((entry) => entry.toolName === "clockify_tags_get")!;
    const shortQuery = normalizeSearchText("ta");
    expect(scoreIndexedOperation(operation, shortQuery, tokenizeSearchText(shortQuery))).toBeUndefined();
    const exactQuery = normalizeSearchText("tag");
    expect(scoreIndexedOperation(operation, exactQuery, tokenizeSearchText(exactQuery))).toBeDefined();
  });

  it("awards the exact operation-id/action-name bonus", () => {
    const operation = index.operations.find((entry) => entry.toolName === "clockify_projects_list")!;
    const exactQuery = normalizeSearchText("getprojects");
    const scored = scoreIndexedOperation(
      operation,
      exactQuery,
      tokenizeSearchText(exactQuery),
    );
    expect(scored?.score).toBeGreaterThanOrEqual(1_000);
  });
});
