import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = (name: string): string => readFileSync(resolve("scripts", name), "utf8");

describe("production HTTP smoke script contracts", () => {
  it.each([
    "live-confirm-flow.ts",
    "live-planner-quirks.ts",
    "live-invoice-flow.ts",
    "live-chat-tour.ts",
    "repro-chat.ts",
  ])("uses the shared UUID-bearing chat request for %s", (name) => {
    const source = script(name);
    expect(source).toContain("createChatRequestBody");
    expect(source).not.toMatch(/JSON\.stringify\(\{\s*message\s*\}\)/);
    expect(source).not.toMatch(/\.send\(\{\s*message\s*\}\)/);
  });

  it("does not report unsupported adapter behavior as an expected success", () => {
    const source = script("live-full.ts");
    expect(source).not.toContain('"UNSUPPORTED"');
    expect(source).not.toContain("adapter method not implemented; expected");
  });

  it.each(["live-scope-probe.ts", "host-auth-spike.ts"])(
    "does not serialize raw workspace or request-path fields in %s",
    (name) => {
      const source = script(name);
      expect(source).not.toMatch(/workspaceId,\s*\n\s*tokenIncluded/);
      expect(source).not.toMatch(/interface ProbeResult[\s\S]*?\n\s*path: string;/);
      expect(source).not.toMatch(/detail:\s*msg\.slice/);
    },
  );

  it("binds the scope/AUDIT probe to a deployed server-minted fresh-install attestation and exact release", () => {
    const source = script("live-scope-probe.ts");
    expect(source).toContain("createAuthenticatedFreshInstallEvidence");
    expect(source).toContain("release/install-attestation/${encodeURIComponent(workspaceId)}");
    expect(source).toContain('"X-Addon-Token": addonToken');
    expect(source).toContain('fetchDeployedJson("release/install-attestation/verify"');
    expect(source).toContain("buildManifest");
    expect(source).toContain("manifestSha256");
    expect(source).toContain('fetchDeployedJson("manifest")');
    expect(source).toContain('fetchDeployedJson("version")');
    expect(source).toContain("verifyDeployedReleaseBinding");
    expect(source).toContain("LIVE_RELEASE_SHA");
    expect(source).toContain('execFileSync("git", ["rev-parse", "HEAD"]');
    expect(source).toContain('mode: "exact_endpoint_per_scope_fresh_install"');
    expect(source).toContain('perScopeNecessity: "platform_resource_action_contract"');
    expect(source).toContain("CLOCKIFY_SCOPE_ENFORCEMENT_SHA256");
    expect(source).toContain('host: "audit"');
    expect(source).toContain('path: `${ws}/audit-log`');
    expect(source).not.toContain("claims.iat");
    expect(source).not.toContain("LIVE_SCOPE_INSTALL_EVENT_PATH");
    expect(source).not.toContain("createFreshInstallEvidence");
    expect(source).not.toContain("immutable_install_event");
    expect(source).not.toContain("LIVE_SCOPE_INSTALL_REFERENCE");
    expect(source).not.toContain("LIVE_SCOPE_INSTALL_AT");
    expect(source).not.toContain("freshInstallAttested: true");
  });

  it("records AUDIT-host evidence only when a release-bound add-on token clears every host", () => {
    const source = script("host-auth-spike.ts");
    expect(source).toContain("HOST_AUTH_EVIDENCE_PATH");
    expect(source).toContain("LIVE_RELEASE_SHA");
    expect(source).toContain("Boolean(ADDON_TOKEN)");
    expect(source).toContain('conclusion: productionClear ? "passed" : "failed"');
  });

  it("keeps a captured installation token in an owner-only environment file", () => {
    const source = script("capture-addon-token.ts");
    expect(source).toContain("mode: 0o600");
    expect(source).toContain("chmodSync(\".env\", 0o600)");
    expect(source).not.toContain("scripts/addon-smoke.ts");
  });

  it("fails the agentic evaluation when any configured case does not pass", () => {
    const source = script("eval-agentic.ts");
    expect(source).toContain("passRuns !== totalRuns || safetyViolations.length > 0");
  });

  it("provides one canonical manifest-hash command for deployed attestation checks", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
    const source = script("manifest-hash.ts");
    expect(pkg.scripts?.["manifest:hash"]).toContain("scripts/manifest-hash.ts");
    expect(source).toContain("buildManifest");
    expect(source).toContain("hashCanonicalJson");
    expect(source).toContain("LIVE_ADDON_BASE_URL");
  });
});
