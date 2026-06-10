import { describe, expect, it } from "vitest";
import {
  expiryView,
  formatCountdown,
  humanizeGroup,
  isNearBottom,
  levelLabel,
  msUntil,
} from "../../src/ui/main.js";

const NOW = Date.parse("2026-06-11T12:00:00.000Z");

describe("countdown formatting (preview expiry pill)", () => {
  it("formats minutes:seconds", () => {
    expect(formatCountdown(299_000)).toBe("4:59");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(5_000)).toBe("0:05");
  });

  it("clamps zero and negative to 0:00", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-12_000)).toBe("0:00");
  });

  it("msUntil is NaN-safe on malformed dates", () => {
    expect(msUntil("2026-06-11T12:05:00.000Z", NOW)).toBe(300_000);
    expect(Number.isNaN(msUntil("not-a-date", NOW))).toBe(true);
  });
});

describe("expiryView (advisory only — the server's TTL stays authoritative)", () => {
  it("future expiry → counting label", () => {
    expect(expiryView("2026-06-11T12:04:59.000Z", NOW)).toEqual({
      expired: false,
      label: "Expires in 4:59",
    });
  });

  it("past expiry → expired", () => {
    expect(expiryView("2026-06-11T11:59:59.000Z", NOW)).toEqual({ expired: true, label: "Expired" });
  });

  it("absent or malformed expiresAt → undefined (old previews render without a pill)", () => {
    expect(expiryView(undefined, NOW)).toBeUndefined();
    expect(expiryView("garbage", NOW)).toBeUndefined();
  });
});

describe("isNearBottom (smart auto-scroll predicate)", () => {
  it("at the bottom → true; within slack → true", () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollTop: 860, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("scrolled up past the slack → false (the log must not yank down)", () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it("content shorter than the viewport → true", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 })).toBe(true);
  });

  it("honors a custom slack", () => {
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 100 }, 250)).toBe(true);
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 100 }, 100)).toBe(false);
  });
});

describe("permission labels (display only — wire values stay raw)", () => {
  it("humanizes feature-group keys", () => {
    expect(humanizeGroup("time_tracking")).toBe("Time tracking");
    expect(humanizeGroup("users_groups")).toBe("Users & groups");
    expect(humanizeGroup("audit_log")).toBe("Audit log");
  });

  it("labels permission levels", () => {
    expect(levelLabel("off")).toBe("Off");
    expect(levelLabel("read")).toBe("Read only");
    expect(levelLabel("read_write")).toBe("Read & write");
    expect(levelLabel("future_level")).toBe("future_level");
  });
});
