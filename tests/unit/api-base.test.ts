import { describe, expect, it } from "vitest";
import {
  resolveClockifyApiBase,
  resolveClockifyAuditBase,
  resolveClockifyReportsBase,
} from "../../src/clockify/api-base.js";

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

/**
 * Clockify publishes NO audit URL claim (the documented claims are
 * backendUrl/reportsUrl/locationsUrl/screenshotsUrl — MARKETPLACE_OCS 08/09, and
 * confirmed by decoding live install + user tokens). The audit log lives only on
 * the `auditlog-api.api.<tenant>` subdomain, which exists exclusively where the
 * API itself is served from `api.<tenant>` (production / regional). Dev, subdomain
 * and path-based hosts (e.g. developer.clockify.me/api) have no audit host — the
 * resolver returns undefined so the adapter can surface a clean
 * "audit log not available in this environment" error instead of fetching a
 * non-existent host (a raw DNS "fetch failed").
 */
describe("resolveClockifyAuditBase", () => {
  it("derives the audit subdomain from the production api host (+ /v1)", () => {
    expect(resolveClockifyAuditBase({ apiUrl: "https://api.clockify.me/api" })).toBe(
      "https://auditlog-api.api.clockify.me/v1",
    );
  });

  it("derives a regional audit host from a regional api.<region> host", () => {
    expect(resolveClockifyAuditBase({ apiUrl: "https://api.eu.clockify.me/api" })).toBe(
      "https://auditlog-api.api.eu.clockify.me/v1",
    );
  });

  it("returns undefined for the dev/path host (developer.clockify.me has no audit host)", () => {
    expect(resolveClockifyAuditBase({ apiUrl: "https://developer.clockify.me/api" })).toBeUndefined();
  });

  it("returns undefined when nothing is provided", () => {
    expect(resolveClockifyAuditBase({})).toBeUndefined();
  });
});
