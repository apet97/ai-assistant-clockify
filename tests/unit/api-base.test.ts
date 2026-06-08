import { describe, expect, it } from "vitest";
import { resolveClockifyApiBase, resolveClockifyReportsBase } from "../../src/clockify/api-base.js";

/**
 * The installed add-on must call the API host from the install context, with the
 * REST version path `/v1` (NOT `/api/v1`). Regressions here cause the live 401
 * "Token is not valid" (prod host + dev token) or 404 (double `/api`).
 */
describe("resolveClockifyApiBase", () => {
  it("uses the payload apiUrl (lifecycle token often omits backendUrl) + /v1", () => {
    expect(resolveClockifyApiBase({ apiUrl: "https://developer.clockify.me/api" })).toBe(
      "https://developer.clockify.me/api/v1",
    );
  });

  it("prefers apiUrl over backendUrl", () => {
    expect(
      resolveClockifyApiBase({
        apiUrl: "https://developer.clockify.me/api",
        backendUrl: "https://api.clockify.me/api",
      }),
    ).toBe("https://developer.clockify.me/api/v1");
  });

  it("falls back to backendUrl when apiUrl is absent", () => {
    expect(resolveClockifyApiBase({ backendUrl: "https://api.clockify.me/api" })).toBe(
      "https://api.clockify.me/api/v1",
    );
  });

  it("never double-appends /v1 and trims trailing slashes", () => {
    expect(resolveClockifyApiBase({ apiUrl: "https://x.clockify.me/api/v1" })).toBe(
      "https://x.clockify.me/api/v1",
    );
    expect(resolveClockifyApiBase({ apiUrl: "https://x.clockify.me/api/" })).toBe(
      "https://x.clockify.me/api/v1",
    );
  });

  it("defaults to the production host when nothing is provided", () => {
    expect(resolveClockifyApiBase({})).toBe("https://api.clockify.me/api/v1");
  });
});

describe("resolveClockifyReportsBase", () => {
  it("uses the reportsUrl claim + /v1 (dev: same host, /report path)", () => {
    expect(resolveClockifyReportsBase({ reportsUrl: "https://developer.clockify.me/report" })).toBe(
      "https://developer.clockify.me/report/v1",
    );
  });

  it("works for the prod reports subdomain", () => {
    expect(resolveClockifyReportsBase({ reportsUrl: "https://reports.api.clockify.me" })).toBe(
      "https://reports.api.clockify.me/v1",
    );
  });

  it("returns undefined when not captured (core falls back to derivation)", () => {
    expect(resolveClockifyReportsBase({})).toBeUndefined();
  });
});
