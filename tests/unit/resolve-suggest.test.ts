import { describe, expect, it } from "vitest";
import { suggestOptions } from "../../src/harness/workflows/resolve.js";

describe("suggestOptions", () => {
  it("prefers candidates whose name contains the query", () => {
    const opts = suggestOptions(
      [
        { id: "1", name: "Website Redesign" },
        { id: "2", name: "Mobile App" },
        { id: "3", name: "Website Backend" },
      ],
      "website",
    );
    expect(opts.map((o) => o.label)).toEqual(["Website Redesign", "Website Backend"]);
  });

  it("falls back to all candidates when none contain the query (did-you-mean)", () => {
    const opts = suggestOptions([{ id: "1", name: "Alpha" }, { id: "2", name: "Beta" }], "zzz");
    expect(opts.map((o) => o.id)).toEqual(["1", "2"]);
  });

  it("caps the number of options", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `P${i}` }));
    expect(suggestOptions(many, "nomatch").length).toBe(12);
  });

  it("excludes archived candidates and returns [] when there are none", () => {
    expect(suggestOptions([{ id: "1", name: "Old", archived: true }], "old")).toEqual([]);
    expect(suggestOptions([], "anything")).toEqual([]);
  });

  it("maps to {id,label} clarify options", () => {
    expect(suggestOptions([{ id: "c1", name: "Acme" }], "acme")).toEqual([{ id: "c1", label: "Acme" }]);
  });
});
