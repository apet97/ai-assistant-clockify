import { describe, expect, it } from "vitest";
import { isAdminRole } from "../../src/auth/roles.js";

describe("isAdminRole", () => {
  it.each(["OWNER", "ADMIN", "owner", "admin", "Owner", "Admin"])(
    "accepts %s",
    (role) => {
      expect(isAdminRole(role)).toBe(true);
    },
  );

  it.each(["USER", "MEMBER", "user", "member", "", "  ", undefined, null, 123])(
    "rejects %s",
    (role) => {
      expect(isAdminRole(role)).toBe(false);
    },
  );
});
