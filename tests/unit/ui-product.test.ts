import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_PREFERENCES,
  firstRunDisclosure,
  formatLocalDateTime,
  formatLocalCurrency,
  formatTimeZoneName,
  normalizeUiPreferences,
  promptsForPolicy,
} from "../../src/ui/product.js";

describe("UI product preferences", () => {
  it("fails closed to the compact, system-theme English preference defaults", () => {
    expect(normalizeUiPreferences({ theme: "neon", language: "xx" })).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences({ theme: "dark", language: "sr" })).toEqual({ theme: "dark", language: "sr" });
    expect(normalizeUiPreferences({ theme: "dark", language: "sr", timeZone: "Europe/Belgrade" })).toEqual({
      theme: "dark",
      language: "sr",
      timeZone: "Europe/Belgrade",
    });
  });

  it("formats dates with Intl for the selected language rather than string slicing", () => {
    expect(formatLocalDateTime("2026-07-18T13:05:00.000Z", "en", "UTC")).toMatch(/Jul|July/);
    expect(formatLocalDateTime("not-a-date", "sr", "UTC")).toBe("not-a-date");
    expect(formatLocalCurrency(1234.5, "EUR", "sr")).toMatch(/1[.,]234|1\.234/);
    expect(formatTimeZoneName("Europe/Belgrade", "en", new Date("2026-07-18T12:00:00.000Z")))
      .toMatch(/Europe\/Belgrade/u);
  });
});

describe("policy-aware entry", () => {
  it("does not offer an invoice prompt when invoices are off", () => {
    const prompts = promptsForPolicy({ version: 1, groups: { invoices: "off", time_tracking: "read_write" } });
    expect(prompts.join(" ")).not.toMatch(/invoice/i);
    expect(prompts.join(" ")).toMatch(/track/i);
  });

  it("offers read prompts but no writes when every enabled group is read-only", () => {
    const prompts = promptsForPolicy({
      version: 1,
      groups: {
        time_tracking: "read",
        reports: "read",
        expenses: "read",
        invoices: "read",
        time_off_approvals: "read",
        workspace_settings: "read",
      },
    }).join(" ");

    expect(prompts).toMatch(/track today/i);
    expect(prompts).toMatch(/summary report/i);
    expect(prompts).not.toMatch(/start a timer|log 2 hours|travel expense|invoice a client|request 2 days/i);
  });

  it("does not suggest an unavailable workspace read when every group is off", () => {
    expect(promptsForPolicy({ version: 1, groups: { reports: "off", time_tracking: "off" } })).toEqual([
      "How do assistant permissions work?",
    ]);
  });

  it("discloses DeepSeek processing, local retention, and button-only confirmation", () => {
    const disclosure = firstRunDisclosure();
    expect(disclosure).toMatch(/DeepSeek/i);
    expect(disclosure).toMatch(/90 days/i);
    expect(disclosure).toMatch(/button/i);
    expect(disclosure).toMatch(/provider/i);
  });
});
