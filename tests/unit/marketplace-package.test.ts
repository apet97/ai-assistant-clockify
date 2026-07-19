import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = async (path: string): Promise<string> => readFile(resolve(path), "utf8");

describe("marketplace submission package", () => {
  it("supplies final portal pricing, Terms URL, and paste-ready 1.0.0 release notes", async () => {
    const [listing, whatsNew, terms] = await Promise.all([
      read("docs/marketplace/01-listing-package.md"),
      read("docs/marketplace/04-whats-new-1.0.0.md"),
      read("TERMS.md"),
    ]);

    expect(listing).toContain("| Pricing | Free add-on; Clockify Pro required |");
    expect(listing).toContain("plus `/terms`");
    expect(listing).not.toContain("if that field is present");
    expect(whatsNew).toContain("# What's New - version 1.0.0");
    expect(whatsNew).toContain("## Paste-ready release summary");
    expect(whatsNew).toContain("admin-only");
    expect(terms).toContain("# Terms of Use - AI Assistant for Clockify");
    expect(terms).toContain("partial or unknown outcome");

    const shortDescription = /\| Short description \| ([^|]+) \|/.exec(listing)?.[1]?.trim() ?? "";
    const fullDescription = /## Full description\n\n([\s\S]*?)\n\n## Privacy disclosure copy/
      .exec(listing)?.[1]
      ?.split("\n")
      .map((line) => line.replace(/^> ?/, ""))
      .join("\n")
      .trim() ?? "";
    expect(shortDescription.length).toBeGreaterThan(0);
    expect(shortDescription.length).toBeLessThanOrEqual(140);
    expect(fullDescription.length).toBeGreaterThan(0);
    expect(fullDescription.length).toBeLessThanOrEqual(1_500);
  });

  it("describes authorization truthfully as preceding an action rather than every Clockify read", async () => {
    const listing = await read("docs/marketplace/01-listing-package.md");

    expect(listing).not.toContain("risk before contacting Clockify");
    expect(listing).toContain("risk before executing the requested Clockify action");
  });

  it("documents post-commit media binding without a self-referential checked-in SHA", async () => {
    const listing = await read("docs/marketplace/01-listing-package.md");

    expect(listing).toContain("post-commit workflow artifact");
    expect(listing).toContain("`github.sha`");
    expect(listing).not.toContain("asset-evidence.json` binds the captures to the release SHA/archive hash");
  });

  it("makes the release runbook validate an explicit HTTPS BASE_URL before deployment checks", async () => {
    const [runbook, pkg] = await Promise.all([
      read("docs/marketplace/03-operations-evidence-rollback-package.md"),
      read("package.json"),
    ]);

    const baseUrlGuard = runbook.indexOf(': "${BASE_URL:?');
    const validator = runbook.indexOf("release:validate-base-url");
    const firstUse = runbook.indexOf('"$BASE_URL/version"');
    expect(baseUrlGuard).toBeGreaterThan(0);
    expect(validator).toBeGreaterThan(baseUrlGuard);
    expect(firstUse).toBeGreaterThan(validator);
    expect(JSON.parse(pkg).scripts["release:validate-base-url"]).toBe("tsx scripts/validate-release-base-url.ts");

    const tsx = resolve("node_modules/.bin/tsx");
    const script = resolve("scripts/validate-release-base-url.ts");
    expect(execFileSync(tsx, [script, "https://assistant.example"], { encoding: "utf8" }).trim())
      .toBe("https://assistant.example");
    expect(() => execFileSync(tsx, [script, "http://assistant.example"], { stdio: "pipe" }))
      .toThrow();
  });
});
