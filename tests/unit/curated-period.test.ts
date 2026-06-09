import { describe, expect, it } from "vitest";
import { resolvePeriod } from "../../src/harness/workflows/curated.js";

const NOW = new Date("2026-06-05T00:00:00.000Z"); // a Friday

describe("resolvePeriod", () => {
  it("today → start of today through now", () => {
    expect(resolvePeriod(NOW, "today")).toEqual({
      dateRangeStart: "2026-06-05T00:00:00.000Z",
      dateRangeEnd: "2026-06-05T23:59:59.999Z",
    });
  });

  it("yesterday → the full previous calendar day", () => {
    expect(resolvePeriod(NOW, "yesterday")).toEqual({
      dateRangeStart: "2026-06-04T00:00:00.000Z",
      dateRangeEnd: "2026-06-04T23:59:59.999Z",
    });
  });

  it("last_7_days → a rolling 7-day window ending now", () => {
    expect(resolvePeriod(NOW, "last_7_days")).toEqual({
      dateRangeStart: "2026-05-29T00:00:00.000Z",
      dateRangeEnd: "2026-06-05T00:00:00.000Z",
    });
  });

  it("this_month → first of the month through now", () => {
    expect(resolvePeriod(NOW, "this_month")).toEqual({
      dateRangeStart: "2026-06-01T00:00:00.000Z",
      dateRangeEnd: "2026-06-05T00:00:00.000Z",
    });
  });

  it("last_month → the full previous calendar month", () => {
    expect(resolvePeriod(NOW, "last_month")).toEqual({
      dateRangeStart: "2026-05-01T00:00:00.000Z",
      dateRangeEnd: "2026-05-31T23:59:59.999Z",
    });
  });
});
