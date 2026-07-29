import { describe, expect, it } from "vitest";
import { logAlias } from "../../src/log-alias.js";

/**
 * Closure-plan PR 11 (F14): operational identifiers are logged only as short,
 * stable, domain-separated HMAC aliases — never raw.
 */
describe("logAlias", () => {
  const secret = "unit-test-alias-secret";
  const id = "64ad1305c701cc5be7c26fe4";

  it("is deterministic for the same secret/kind/id and never contains the raw id", () => {
    const first = logAlias(secret, "workspace", id);
    expect(logAlias(secret, "workspace", id)).toBe(first);
    expect(first).toMatch(/^ws-[A-Za-z0-9_-]{12}$/);
    expect(first).not.toContain(id);
    expect(first).not.toContain(id.slice(0, 8));
  });

  it("is domain-separated: the same id aliases differently per kind", () => {
    const workspace = logAlias(secret, "workspace", id);
    const admin = logAlias(secret, "admin", id);
    const addon = logAlias(secret, "addon", id);
    expect(admin.replace(/^adm-/, "")).not.toBe(workspace.replace(/^ws-/, ""));
    expect(addon.replace(/^addon-/, "")).not.toBe(workspace.replace(/^ws-/, ""));
  });

  it("changes with the secret and marks an absent id without hashing", () => {
    expect(logAlias("other-secret", "workspace", id)).not.toBe(logAlias(secret, "workspace", id));
    expect(logAlias(secret, "addon", "")).toBe("addon-absent");
  });
});
