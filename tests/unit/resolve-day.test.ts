import { describe, expect, it } from "vitest";
import { resolveInstant, resolveRelativeDay } from "../../src/harness/workflows/resolve.js";

// 2026-06-10 is a WEDNESDAY.
const NOW = new Date("2026-06-10T12:00:00.000Z");

describe("resolveRelativeDay", () => {
  it("keeps the existing contract: today/yesterday/tomorrow/dayOffset/ISO/default-today", () => {
    expect(resolveRelativeDay(NOW, {})).toBe("2026-06-10");
    expect(resolveRelativeDay(NOW, { date: "today" })).toBe("2026-06-10");
    expect(resolveRelativeDay(NOW, { date: "Yesterday" })).toBe("2026-06-09");
    expect(resolveRelativeDay(NOW, { date: "tomorrow" })).toBe("2026-06-11");
    expect(resolveRelativeDay(NOW, { dayOffset: -2 })).toBe("2026-06-08");
    expect(resolveRelativeDay(NOW, { date: "2026-06-01" })).toBe("2026-06-01");
    expect(resolveRelativeDay(NOW, { date: "2026-06-01T09:30:00Z" })).toBe("2026-06-01");
  });

  it("resolves bare weekday words to the NEXT occurrence (today counts)", () => {
    // From Wednesday: friday = this week's Friday; wednesday = today; monday = next week.
    expect(resolveRelativeDay(NOW, { date: "friday" })).toBe("2026-06-12");
    expect(resolveRelativeDay(NOW, { date: "Wednesday" })).toBe("2026-06-10");
    expect(resolveRelativeDay(NOW, { date: "monday" })).toBe("2026-06-15");
  });

  it("resolves 'next <weekday>' strictly after today (live: time-off sent the literal 'next Monday')", () => {
    expect(resolveRelativeDay(NOW, { date: "next Monday" })).toBe("2026-06-15");
    expect(resolveRelativeDay(NOW, { date: "next wednesday" })).toBe("2026-06-17");
    expect(resolveRelativeDay(NOW, { date: "next sunday" })).toBe("2026-06-14");
  });

  it("resolves 'last <weekday>' strictly before today", () => {
    expect(resolveRelativeDay(NOW, { date: "last monday" })).toBe("2026-06-08");
    expect(resolveRelativeDay(NOW, { date: "last wednesday" })).toBe("2026-06-03");
  });

  it("resolves a month-name + day partial date to the CURRENT year (the model must not fabricate a year)", () => {
    // "June 1 to June 5" (no year) must mean 2026 — the year of `now` — never a
    // training-data default like 2025. The harness owns the year, not the model.
    expect(resolveRelativeDay(NOW, { date: "June 1" })).toBe("2026-06-01");
    expect(resolveRelativeDay(NOW, { date: "june 5" })).toBe("2026-06-05");
    expect(resolveRelativeDay(NOW, { date: "Jun 1" })).toBe("2026-06-01");
    expect(resolveRelativeDay(NOW, { date: "June 1st" })).toBe("2026-06-01");
    expect(resolveRelativeDay(NOW, { date: "3 March" })).toBe("2026-03-03");
    expect(resolveRelativeDay(NOW, { date: "December 31" })).toBe("2026-12-31");
  });

  it("rejects an out-of-range day in a month-name partial (clarify, never send)", () => {
    expect(resolveRelativeDay(NOW, { date: "February 30" })).toBeUndefined();
    expect(resolveRelativeDay(NOW, { date: "June 0" })).toBeUndefined();
  });

  it("returns undefined on unparseable input — callers must clarify, never send it to the wire", () => {
    expect(resolveRelativeDay(NOW, { date: "banana" })).toBeUndefined();
    expect(resolveRelativeDay(NOW, { date: "06/10/2026" })).toBeUndefined();
    expect(resolveRelativeDay(NOW, { date: "2026-13-99" })).toBeUndefined();
  });
});

describe("resolveInstant", () => {
  it("turns a day reference into a start-of-day / end-of-day UTC instant", () => {
    expect(resolveInstant(NOW, "today", "start")).toBe("2026-06-10T00:00:00.000Z");
    expect(resolveInstant(NOW, "today", "end")).toBe("2026-06-10T23:59:59.999Z");
    expect(resolveInstant(NOW, "last monday", "start")).toBe("2026-06-08T00:00:00.000Z");
    expect(resolveInstant(NOW, "2026-06-01", "end")).toBe("2026-06-01T23:59:59.999Z");
  });

  it("passes a full ISO datetime through, normalized to a UTC instant", () => {
    expect(resolveInstant(NOW, "2026-06-01T09:30:00Z", "start")).toBe("2026-06-01T09:30:00.000Z");
    expect(resolveInstant(NOW, "2026-06-01T09:30:00.000+02:00", "start")).toBe(
      "2026-06-01T07:30:00.000Z",
    );
  });

  it("resolves a month-name + day partial date to the CURRENT-year start/end instant (report range without a year)", () => {
    // The finding: "report from June 1 to June 5" must run for 2026, not 2025.
    expect(resolveInstant(NOW, "June 1", "start")).toBe("2026-06-01T00:00:00.000Z");
    expect(resolveInstant(NOW, "June 5", "end")).toBe("2026-06-05T23:59:59.999Z");
  });

  it("returns undefined on unparseable input", () => {
    expect(resolveInstant(NOW, "next sprint", "start")).toBeUndefined();
    expect(resolveInstant(NOW, "2026-06-01Tbanana", "start")).toBeUndefined();
  });

  it("resolves FORWARD period keywords — 'next week'/'next month' (live item 321: a scheduling range of 'next month' dead-ended in a clarify)", () => {
    // NOW = Wednesday 2026-06-10; this week's Monday is 06-08 → next week = 06-15..06-21.
    expect(resolveInstant(NOW, "next week", "start")).toBe("2026-06-15T00:00:00.000Z");
    expect(resolveInstant(NOW, "next week", "end")).toBe("2026-06-21T23:59:59.999Z");
    expect(resolveInstant(NOW, "next month", "start")).toBe("2026-07-01T00:00:00.000Z");
    expect(resolveInstant(NOW, "next month", "end")).toBe("2026-07-31T23:59:59.999Z");
  });

  it("accepts the period keywords the planner emits as date values (live: entries_list got start='last_7_days' twice)", () => {
    // Edge semantics: a period maps to its own start/end instant.
    expect(resolveInstant(NOW, "last_7_days", "start")).toBe(
      new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
    );
    expect(resolveInstant(NOW, "last_7_days", "end")).toBe(NOW.toISOString());
    // 2026-06-10 is a Wednesday → last week = Mon 2026-06-01 … Sun 2026-06-07.
    expect(resolveInstant(NOW, "last week", "start")).toBe("2026-06-01T00:00:00.000Z");
    expect(resolveInstant(NOW, "Last Week", "end")).toBe("2026-06-07T23:59:59.999Z");
    expect(resolveInstant(NOW, "this_month", "start")).toBe("2026-06-01T00:00:00.000Z");
  });
});
