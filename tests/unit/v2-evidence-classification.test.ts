import { describe, expect, it } from "vitest";

import {
  classifyCurrentV2Evidence,
  classifyHistoricalV1Evidence,
} from "../../scripts/evidence/release-evidence.js";

describe("B6: the v2 evidence classification beside the v1 rollback contract", () => {
  it("classifies a v2 target as current, valid-for-v2 evidence", () => {
    expect(classifyCurrentV2Evidence("v2")).toEqual({
      assistantEngine: "v2",
      evidenceStatus: "current",
      validForV2: true,
    });
  });

  it("rejects a v1 target before any artifact is parsed", () => {
    expect(() => classifyCurrentV2Evidence("v1")).toThrow(
      /current v2 evidence is not valid for v1/iu,
    );
  });

  it("leaves the v1 rollback contract untouched: v1 still classifies as historical and still rejects v2", () => {
    expect(classifyHistoricalV1Evidence("v1")).toEqual({
      assistantEngine: "v1",
      evidenceStatus: "historical",
      validForV2: false,
    });
    expect(() => classifyHistoricalV1Evidence("v2")).toThrow(
      /historical v1 evidence is not valid for v2/iu,
    );
  });
});
