import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = ["styles.css", "product.css"]
  .map((file) => readFileSync(fileURLToPath(new URL(`../../src/ui/${file}`, import.meta.url)), "utf8"))
  .join("\n");

function blockAt(marker: string, from = 0): string {
  const start = css.indexOf(marker, from);
  if (start < 0) throw new Error(`Missing CSS block ${marker}`);
  const opening = css.indexOf("{", start + marker.length);
  let depth = 0;
  for (let index = opening; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(opening + 1, index);
  }
  throw new Error(`Unclosed CSS block ${marker}`);
}

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)]
      .map((match) => [match[1], match[2].toLowerCase()]),
  );
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function composite(foreground: string, background: string, opacity: number): string {
  const channel = (offset: number): string => {
    const foregroundValue = Number.parseInt(foreground.slice(offset, offset + 2), 16);
    const backgroundValue = Number.parseInt(background.slice(offset, offset + 2), 16);
    return Math.round((foregroundValue * opacity) + (backgroundValue * (1 - opacity)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

function opacityFor(selector: string): number {
  if (!css.includes(selector)) return 1;
  const match = blockAt(selector).match(/(?:^|;)\s*opacity\s*:\s*([0-9.]+)/);
  return match ? Number(match[1]) : 1;
}

function themeTokens(): Record<string, Record<string, string>> {
  const base = tokens(blockAt(":root"));
  const media = css.indexOf("@media (prefers-color-scheme: light)");
  const systemLight = tokens(blockAt(":root", media));
  return {
    systemLight: { ...base, ...systemLight },
    explicitLight: { ...base, ...tokens(blockAt(':root[data-theme="light"]')) },
    explicitDark: { ...base, ...tokens(blockAt(':root[data-theme="dark"]')) },
  };
}

describe("small-text theme contrast", () => {
  it("keeps every normal-size text token at WCAG AA contrast on UI surfaces", () => {
    const failures: string[] = [];
    for (const [theme, values] of Object.entries(themeTokens())) {
      for (const foreground of ["--text", "--text-2", "--text-3", "--accent", "--ok", "--warn", "--danger"]) {
        for (const background of ["--bg", "--surface", "--surface-2"]) {
          const ratio = contrast(values[foreground], values[background]);
          if (ratio < 4.5) failures.push(`${theme} ${foreground}/${background}=${ratio.toFixed(2)}`);
        }
      }
      const whiteOnButton = contrast("#ffffff", values["--accent-strong"]);
      if (whiteOnButton < 4.5) failures.push(`${theme} white/--accent-strong=${whiteOnButton.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("keeps expired and settled preview text at effective AA contrast in light and dark themes", () => {
    const failures: string[] = [];
    const themes = themeTokens();
    for (const theme of ["explicitLight", "explicitDark"] as const) {
      const values = themes[theme];
      for (const selector of [".preview-card.expired", ".preview-card.settled"]) {
        const opacity = opacityFor(selector);
        const effectiveText = composite(values["--text-3"], values["--bg"], opacity);
        const effectiveSurface = composite(values["--surface"], values["--bg"], opacity);
        const ratio = contrast(effectiveText, effectiveSurface);
        if (ratio < 4.5) failures.push(`${theme} ${selector}=${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
