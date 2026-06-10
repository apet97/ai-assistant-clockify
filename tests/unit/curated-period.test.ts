import { describe, expect, it } from "vitest";
import { resolvePeriod } from "../../src/harness/workflows/resolve.js";

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

  // Forward periods (live item 321): "next week"/"next month" are natural for
  // scheduling/time-off ranges and used to dead-end in an honest clarify.
  it("next_week → the full FOLLOWING Monday-to-Sunday week", () => {
    // NOW = Friday 2026-06-05; this week's Monday is 06-01 → next week = 06-08..06-14.
    expect(resolvePeriod(NOW, "next_week")).toEqual({
      dateRangeStart: "2026-06-08T00:00:00.000Z",
      dateRangeEnd: "2026-06-14T23:59:59.999Z",
    });
  });

  it("next_month → the full following calendar month (incl. year rollover)", () => {
    expect(resolvePeriod(NOW, "next_month")).toEqual({
      dateRangeStart: "2026-07-01T00:00:00.000Z",
      dateRangeEnd: "2026-07-31T23:59:59.999Z",
    });
    expect(resolvePeriod(new Date("2026-12-15T00:00:00.000Z"), "next_month")).toEqual({
      dateRangeStart: "2027-01-01T00:00:00.000Z",
      dateRangeEnd: "2027-01-31T23:59:59.999Z",
    });
  });

  it("next_quarter → the full following quarter (incl. year rollover)", () => {
    expect(resolvePeriod(NOW, "next_quarter")).toEqual({
      dateRangeStart: "2026-07-01T00:00:00.000Z",
      dateRangeEnd: "2026-09-30T23:59:59.999Z",
    });
    expect(resolvePeriod(new Date("2026-11-20T00:00:00.000Z"), "next_quarter")).toEqual({
      dateRangeStart: "2027-01-01T00:00:00.000Z",
      dateRangeEnd: "2027-03-31T23:59:59.999Z",
    });
  });

  it("next_year → the full following calendar year", () => {
    expect(resolvePeriod(NOW, "next_year")).toEqual({
      dateRangeStart: "2027-01-01T00:00:00.000Z",
      dateRangeEnd: "2027-12-31T23:59:59.999Z",
    });
  });
});
