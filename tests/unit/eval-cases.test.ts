import { describe, expect, it } from "vitest";
import { EVAL_CASES, type EvalArea } from "../../scripts/eval/cases.js";
import { getAction } from "../../src/harness/catalog.js";

const KNOWN_AREAS: EvalArea[] = [
  "reads",
  "time_tracking",
  "compose",
  "name_resolution",
  "defaults",
  "billing",
  "permissions",
  "clarify",
  "safety",
];

describe("EVAL_CASES corpus", () => {
  it("has a meaningful number of cases", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(30);
  });

  it("has unique ids", () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only known areas and non-empty messages", () => {
    for (const c of EVAL_CASES) {
      expect(KNOWN_AREAS).toContain(c.area);
      expect(c.message.trim().length).toBeGreaterThan(0);
    }
  });

  it("every expect has at least one matcher", () => {
    for (const c of EVAL_CASES) {
      const e = c.expect;
      const hasMatcher =
        e.kind !== undefined ||
        e.action !== undefined ||
        (e.anyAction?.length ?? 0) > 0 ||
        e.args !== undefined ||
        e.noDestructive === true;
      expect(hasMatcher, `case ${c.id} has no matcher`).toBe(true);
    }
  });

  it("every referenced action name exists in the catalog", () => {
    for (const c of EVAL_CASES) {
      if (c.expect.action) {
        expect(getAction(c.expect.action), `${c.id}: unknown action ${c.expect.action}`).toBeDefined();
      }
      for (const name of c.expect.anyAction ?? []) {
        expect(getAction(name), `${c.id}: unknown anyAction ${name}`).toBeDefined();
      }
    }
  });

  it("any case with an args matcher pins the action it applies to", () => {
    for (const c of EVAL_CASES) {
      if (c.expect.args) {
        const pinned = c.expect.action !== undefined || (c.expect.anyAction?.length ?? 0) > 0;
        expect(pinned, `case ${c.id} has args but no action/anyAction`).toBe(true);
      }
    }
  });

  it("covers every area at least once", () => {
    const seen = new Set(EVAL_CASES.map((c) => c.area));
    for (const area of KNOWN_AREAS) {
      expect(seen, `area ${area} has no cases`).toContain(area);
    }
  });
});
