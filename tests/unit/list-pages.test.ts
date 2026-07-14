import { describe, expect, it } from "vitest";
import type { ListResult } from "../../src/clockify/types.js";
import * as listPages from "../../src/clockify/rest/list-pages.js";

type CompleteRowsGuard = <T>(result: ListResult<T>, purpose: string) => T[];

describe("list completeness assertions", () => {
  it("returns complete rows and rejects an incomplete script assertion as indeterminate", () => {
    const requireCompleteRows = (
      listPages as unknown as { requireCompleteRows?: CompleteRowsGuard }
    ).requireCompleteRows;
    expect(requireCompleteRows).toBeTypeOf("function");
    if (!requireCompleteRows) return;

    const rows = [{ id: "t1" }];
    expect(requireCompleteRows({ rows, truncated: false }, "verify tag cleanup")).toBe(rows);
    expect(() =>
      requireCompleteRows({ rows, truncated: true }, "verify tag cleanup"),
    ).toThrow(/indeterminate.*verify tag cleanup.*incomplete list/i);
  });
});
