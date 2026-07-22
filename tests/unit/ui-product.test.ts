import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as product from "../../src/ui/product.js";
import type { UiPreferences, UiTheme } from "../../src/shared/contracts.js";

type ExpectedUiPreferences = { theme: UiTheme; timeZone?: string };
type ExactUiPreferencesShape =
  [keyof UiPreferences] extends [keyof ExpectedUiPreferences]
    ? [keyof ExpectedUiPreferences] extends [keyof UiPreferences]
      ? UiPreferences extends ExpectedUiPreferences
        ? ExpectedUiPreferences extends UiPreferences
          ? true
          : false
        : false
      : false
    : false;

const exactUiPreferencesShape: ExactUiPreferencesShape = true;

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("UI product preferences", () => {
  it("has exactly the language-free public/runtime shape", () => {
    expect(exactUiPreferencesShape).toBe(true);
    expect(product.DEFAULT_UI_PREFERENCES).toEqual({ theme: "system" });
    expect(product.normalizeUiPreferences({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(product.normalizeUiPreferences({ theme: "neon", language: "xx" })).toEqual(product.DEFAULT_UI_PREFERENCES);
    expect(product.normalizeUiPreferences({ theme: "dark", language: "sr", timeZone: "Europe/Belgrade" })).toEqual({
      theme: "dark",
      timeZone: "Europe/Belgrade",
    });
  });

  it("migrates legacy localStorage in place and drops language", () => {
    const storage = {
      getItem: (key: string) => {
        expect(key).toBe("clockify-ai-assistant.preferences.v1");
        return JSON.stringify({ theme: "dark", language: "sr", timeZone: "Europe/Belgrade" });
      },
    };

    expect(product.loadUiPreferences(storage)).toEqual({
      theme: "dark",
      timeZone: "Europe/Belgrade",
    });
  });

  it("sets fixed English document language while preserving theme and timezone", () => {
    const document = { documentElement: { lang: "sr", dataset: {} } };
    product.applyUiPreferences(document.documentElement, { theme: "dark", timeZone: "Europe/Belgrade" });
    expect(document.documentElement).toEqual({
      lang: "en",
      dataset: { theme: "dark", timeZone: "Europe/Belgrade" },
    });
  });

  it("formats dates, money, relative time, and timezone names through one en-US seam", () => {
    expect(Reflect.get(product, "EN_US_LOCALE")).toBe("en-US");
    expect(product.formatLocalDateTime("2026-07-18T13:05:00.000Z", "UTC")).toBe(
      new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
        .format(new Date("2026-07-18T13:05:00.000Z")),
    );
    expect(product.formatLocalDateTime("not-a-date", "UTC")).toBe("not-a-date");
    expect(product.formatLocalCurrency(1234.5, "EUR")).toBe(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(1234.5),
    );
    expect(product.formatTimeZoneName("Europe/Belgrade", new Date("2026-07-18T12:00:00.000Z")))
      .toMatch(/Europe\/Belgrade/u);
  });

  it("removes language controls and dependencies from the compiled preference graph", () => {
    const contracts = source("../../src/shared/contracts.ts");
    const preferenceSource = source("../../src/ui-preferences.ts");
    const component = source("../../src/routes/component.ts");
    const productSource = source("../../src/ui/product.ts");
    const main = source("../../src/ui/main.ts");
    const render = source("../../src/ui/render.ts");
    const protocol = source("../../src/ui/protocol.ts");
    const api = source("../../src/routes/api.ts");

    expect(contracts).not.toMatch(/\bUiLanguage\b/u);
    expect(preferenceSource).not.toMatch(/normalizedLanguage|\blanguage:/u);
    expect(component).not.toContain("claims.language");
    expect(productSource).not.toMatch(/\bintlLocale\b|sr-Latn-RS|\bUiLanguage\b/u);
    expect(productSource).toContain('export const EN_US_LOCALE = "en-US";');
    expect(productSource).toContain("new Intl.DateTimeFormat(EN_US_LOCALE");
    expect(productSource).toContain("new Intl.NumberFormat(EN_US_LOCALE");
    expect(main).toContain("applyUiPreferences(document.documentElement, preferences);");
    expect(main).not.toMatch(/languageLabel|preferences\.language|language\.value|aria-label", "Language"|refreshLocalizedUi/u);
    expect(render).not.toMatch(/\bUiLanguage\b|deps\.language|documentElement\?\.lang === "sr"/u);
    expect(render).toContain("new Intl.RelativeTimeFormat(EN_US_LOCALE");
    expect(protocol).not.toMatch(/preferences\.language|\.language is unknown/u);
    expect(api).not.toContain('language: "en"');
  });
});

describe("policy-aware entry", () => {
  it("does not offer an invoice prompt when invoices are off", () => {
    const prompts = product.promptsForPolicy({ version: 1, groups: { invoices: "off", time_tracking: "read_write" } });
    expect(prompts.join(" ")).not.toMatch(/invoice/i);
    expect(prompts.join(" ")).toMatch(/track/i);
  });

  it("offers read prompts but no writes when every enabled group is read-only", () => {
    const prompts = product.promptsForPolicy({
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
    expect(product.promptsForPolicy({ version: 1, groups: { reports: "off", time_tracking: "off" } })).toEqual([
      "How do assistant permissions work?",
    ]);
  });

  it("discloses DeepSeek processing, local retention, and button-only confirmation", () => {
    const disclosure = product.firstRunDisclosure();
    expect(disclosure).toMatch(/DeepSeek/i);
    expect(disclosure).toMatch(/90 days/i);
    expect(disclosure).toMatch(/button/i);
    expect(disclosure).toMatch(/provider/i);
  });
});
