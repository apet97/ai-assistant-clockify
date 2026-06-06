import { describe, expect, it } from "vitest";
import { buildAddon, buildManifest } from "../../src/addon/manifest.js";

const BASE_URL = "https://example.com/ai-assistant";

describe("manifest", () => {
  it("names the add-on AI Assistant", () => {
    const manifest = buildManifest(BASE_URL);
    expect(manifest.name).toBe("AI Assistant");
    expect(JSON.stringify(manifest)).toContain("AI Assistant");
  });

  it("exposes a single admin-only component at /component/assistant", () => {
    const manifest = buildManifest(BASE_URL);
    expect(manifest.components).toBeDefined();
    const component = manifest.components?.[0];
    expect(component?.path).toBe("/component/assistant");
    expect(component?.accessLevel).toBe("ADMINS");
    expect(component?.label).toBe("AI Assistant");
  });

  it("declares the install/status/delete lifecycle endpoints", () => {
    const manifest = buildManifest(BASE_URL);
    const paths = (manifest.lifecycle ?? []).map((e) => e.path);
    expect(paths).toContain("/lifecycle/installed");
    expect(paths).toContain("/lifecycle/status-changed");
    expect(paths).toContain("/lifecycle/deleted");
  });

  it("requests the read+write scopes the assistant needs", () => {
    const manifest = buildManifest(BASE_URL);
    const scopes = manifest.scopes ?? [];
    expect(scopes).toContain("TIME_ENTRY_READ");
    expect(scopes).toContain("TIME_ENTRY_WRITE");
    expect(scopes).toContain("PROJECT_WRITE");
    expect(scopes).toContain("INVOICE_WRITE");
    expect(scopes.length).toBeGreaterThanOrEqual(20);
  });

  it("builds a ClockifyAddon exposing the manifest via getManifest()", () => {
    const addon = buildAddon(BASE_URL);
    expect(addon.getManifest().name).toBe("AI Assistant");
  });
});
