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

  it("returns undefined on unparseable input", () => {
    expect(resolveInstant(NOW, "next sprint", "start")).toBeUndefined();
    expect(resolveInstant(NOW, "2026-06-01Tbanana", "start")).toBeUndefined();
  });
});
