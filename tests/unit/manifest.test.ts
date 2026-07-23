import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAddon, buildManifest } from "../../src/addon/manifest.js";
import { ENDPOINT_SCOPE_SOURCES } from "../../src/addon/scope-contract.js";

const BASE_URL = "https://example.com/ai-assistant";

describe("manifest", () => {
  it("uses the public marketplace name while keeping the sidebar label short", () => {
    const manifest = buildManifest(BASE_URL);
    expect(manifest.name).toBe("AI Assistant for Clockify");
    expect(manifest.components?.[0]?.label).toBe("AI Assistant");
  });

  it("exposes a single admin-only sidebar component at /component/assistant", () => {
    const manifest = buildManifest(BASE_URL);
    expect(manifest.components).toBeDefined();
    const component = manifest.components?.[0];
    expect(component?.type).toBe("sidebar");
    expect(component?.path).toBe("/component/assistant");
    expect(component?.accessLevel).toBe("ADMINS");
    expect(component?.label).toBe("AI Assistant");
    // Clockify's sidebar is an icon rail — the nav entry needs an icon to render.
    expect(component?.iconPath).toBe("/icon.svg");
  });

  it("declares a top-level add-on icon (sidebar nav entry renders from it)", () => {
    const manifest = buildManifest(BASE_URL);
    expect(manifest.iconPath).toBe("/icon.svg");
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

  it("requests exactly the scopes in the checked-in endpoint contract", () => {
    const manifest = buildManifest(BASE_URL);
    expect(manifest.scopes).toEqual(ENDPOINT_SCOPE_SOURCES.map(({ scope }) => scope));
    expect(manifest.scopes).toContain("REPORTS_READ");
    expect(manifest.scopes).not.toContain("REPORTS_WRITE");
  });

  it("includes binary invoice export in the generated exact endpoint inventory", () => {
    const contractPath = fileURLToPath(new URL("../../docs/ENDPOINT_SCOPE_CONTRACT.md", import.meta.url));
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).toContain("Generated inventory: **122 distinct adapter request shapes**, **149 catalog actions**");
    expect(contract).toContain("`API GET /workspaces/{workspaceId}/invoices/{id}/export`");
  });

  it("labels the mapping as callsite-specific and requires exact per-scope live probes", () => {
    const contractPath = fileURLToPath(new URL("../../docs/ENDPOINT_SCOPE_CONTRACT.md", import.meta.url));
    const generatorPath = fileURLToPath(new URL("../../scripts/generate-endpoint-scope-contract.ts", import.meta.url));
    const contract = readFileSync(contractPath, "utf8");
    const generator = readFileSync(generatorPath, "utf8");

    expect(generator).toContain("multiplyAssigned");
    expect(generator).toContain("scopes.length !== 1");
    expect(contract).toContain("adapter callsite");
    expect(contract).toContain("one distinct exact endpoint probe");
    expect(contract).toContain("Static extraction alone is not treated as live permission evidence");
  });

  it("fails closed when RestCore calls escape the scanned adapter root or use call for a mutation", () => {
    const scannerPath = fileURLToPath(new URL("../../scripts/lib/adapter-endpoints.ts", import.meta.url));
    const workspaceAdapterPath = fileURLToPath(new URL("../../src/clockify/rest-workspace.ts", import.meta.url));
    const scanner = readFileSync(scannerPath, "utf8");
    const workspaceAdapter = readFileSync(workspaceAdapterPath, "utf8");

    expect(scanner).toContain("RestCore callsite outside scanned adapter root");
    expect(scanner).toContain("core.call requires a safe read method");
    expect(scanner).toContain('operation === "postQuery"');
    expect(workspaceAdapter).not.toMatch(/\bcore\.(?:call|postQuery|mutate|paginate|paginateEnvelope|getBinary)\s*\(/u);
    expect(workspaceAdapter).toContain("timeEntryRest.deleteTimeEntryAtomic(i)");
  });

  it("builds a ClockifyAddon exposing the manifest via getManifest()", () => {
    const addon = buildAddon(BASE_URL);
    expect(addon.getManifest().name).toBe("AI Assistant for Clockify");
  });
});
