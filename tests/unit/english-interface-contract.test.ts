import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyUiPreferences,
  EN_US_LOCALE,
  formatLocalDateTime,
} from "../../src/ui/product.js";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const productSource = source("../../src/ui/product.ts");
const mainSource = source("../../src/ui/main.ts");
const renderSource = source("../../src/ui/render.ts");
const protocolSource = source("../../src/ui/protocol.ts");
const apiSource = source("../../src/routes/api.ts");
const contractsSource = source("../../src/shared/contracts.ts");
const preferencesSource = source("../../src/ui-preferences.ts");
const componentSource = source("../../src/routes/component.ts");
const uiRuntimeSource = [productSource, mainSource, renderSource, protocolSource, apiSource].join("\n");
const languageFreeRuntimeSource = [mainSource, renderSource, protocolSource, apiSource].join("\n");
const forbiddenLocaleRuntimePatterns = [
  /\bUiLanguage\b/u,
  /sr-Latn-RS/u,
  /\bintlLocale\b/u,
  /[(,][\t\n\r ]*language[\t\n\r ]*:/u,
  /\blanguage\s*={2,3}\s*["']sr["']/u,
  /case\s+["']sr["']/u,
  /documentElement\??\.lang\s*={2,3}\s*["']sr["']/u,
  /\b(?:preferences|deps)\.language\b/u,
];

describe("English interface source/runtime contract", () => {
  it("owns one fixed en-US display-locale seam with no Serbian runtime branch", () => {
    expect(EN_US_LOCALE).toBe("en-US");
    expect(productSource).toContain('export const EN_US_LOCALE = "en-US";');
    expect(uiRuntimeSource.match(/["']en-US["']/gu)).toEqual(['"en-US"']);
    for (const forbidden of forbiddenLocaleRuntimePatterns) expect(uiRuntimeSource).not.toMatch(forbidden);
    expect(productSource).toContain("new Intl.DateTimeFormat(EN_US_LOCALE");
    expect(productSource).toContain("new Intl.NumberFormat(EN_US_LOCALE");
    expect(renderSource).toContain("new Intl.RelativeTimeFormat(EN_US_LOCALE");
  });

  it("has no language combobox or save/refresh wiring", () => {
    expect(contractsSource).not.toMatch(/\bUiLanguage\b/u);
    expect(preferencesSource).not.toMatch(/normalizedLanguage|\blanguage:/u);
    expect(componentSource).not.toContain("claims.language");
    expect(languageFreeRuntimeSource).not.toMatch(/\blanguage\b/u);
    expect(mainSource).not.toMatch(
      /languageLabel|language\.value|aria-label["',\s]+Language|refreshLocalizedUi/u,
    );
    expect(mainSource).toContain('theme.setAttribute("aria-label", "Theme");');
    expect(mainSource).toContain("const timeZoneSummary");
    expect(apiSource).not.toContain('language: "en"');
  });

  it("sets English document language while retaining theme and verified Clockify timezone", () => {
    const root: { lang: string; dataset: { theme?: string; timeZone?: string } } = {
      lang: "sr",
      dataset: {},
    };

    applyUiPreferences(root, { theme: "dark", timeZone: "Europe/Belgrade" });

    expect(root.lang).toBe("en");
    expect(root.dataset).toEqual({ theme: "dark", timeZone: "Europe/Belgrade" });
    expect(formatLocalDateTime("2026-07-18T13:05:00.000Z", "Europe/Belgrade")).toBe(
      new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Belgrade",
      }).format(new Date("2026-07-18T13:05:00.000Z")),
    );
  });

  it("keeps untrusted UI strings on textContent-only render paths", () => {
    expect([mainSource, renderSource].join("\n")).not.toMatch(/\.innerHTML\s*=/u);
    expect(renderSource).toContain("node.textContent = text;");
  });
});
