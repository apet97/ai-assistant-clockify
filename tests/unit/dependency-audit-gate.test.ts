import { describe, expect, it } from "vitest";

import { inspectProductionAudit } from "../../scripts/dependency-gates/audit.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");
type AuditSeverity = "info" | "low" | "moderate" | "high" | "critical";

const emptyAllowlist = (): unknown => ({
  version: 1,
  entries: [],
});

const auditOutput = (
  advisories: Array<{
    id: number;
    package: string;
    severity: AuditSeverity;
  }>,
): string => JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(advisories.map((advisory) => [
    advisory.package,
    {
      name: advisory.package,
      severity: advisory.severity,
      isDirect: true,
      via: [{
        source: advisory.id,
        name: advisory.package,
        dependency: advisory.package,
        title: `${advisory.package} advisory`,
        url: `https://github.com/advisories/GHSA-${advisory.id}`,
        severity: advisory.severity,
        range: "<1.0.0",
      }],
      effects: [],
      range: "<1.0.0",
      nodes: [`node_modules/${advisory.package}`],
      fixAvailable: false,
    },
  ])),
  metadata: {
    vulnerabilities: {
      info: 0,
      low: advisories.filter(({ severity }) => severity === "low").length,
      moderate: advisories.filter(({ severity }) => severity === "moderate").length,
      high: advisories.filter(({ severity }) => severity === "high").length,
      critical: advisories.filter(({ severity }) => severity === "critical").length,
      total: advisories.length,
    },
    dependencies: {
      prod: 1,
      dev: 0,
      optional: 0,
      peer: 0,
      peerOptional: 0,
      total: 1,
    },
  },
});

const transitiveAuditOutput = (
  parentSeverity: AuditSeverity = "high",
  leafSeverity: AuditSeverity = "high",
): string => {
  const counters: Record<AuditSeverity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  counters[parentSeverity] += 1;
  counters[leafSeverity] += 1;
  return JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    "parent-package": {
      name: "parent-package",
      severity: parentSeverity,
      isDirect: true,
      via: ["leaf-package"],
      effects: [],
      range: "<2.0.0",
      nodes: ["node_modules/parent-package"],
      fixAvailable: false,
    },
    "leaf-package": {
      name: "leaf-package",
      severity: leafSeverity,
      isDirect: false,
      via: [{
        source: 1234,
        name: "leaf-package",
        dependency: "leaf-package",
        title: "leaf-package advisory",
        url: "https://github.com/advisories/GHSA-1234",
        severity: leafSeverity,
        range: "<1.0.0",
      }],
      effects: ["parent-package"],
      range: "<1.0.0",
      nodes: ["node_modules/leaf-package"],
      fixAvailable: false,
    },
  },
  metadata: {
    vulnerabilities: {
      ...counters,
      total: 2,
    },
    dependencies: {
      prod: 2,
      dev: 0,
      optional: 0,
      peer: 0,
      peerOptional: 0,
      total: 2,
    },
  },
  });
};

const aggregateAuditOutput = (
  aggregateSeverity: AuditSeverity,
  causeSeverities: AuditSeverity[],
): string => {
  const counters: Record<AuditSeverity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  counters[aggregateSeverity] = 1;
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      "aggregate-package": {
        name: "aggregate-package",
        severity: aggregateSeverity,
        isDirect: true,
        via: causeSeverities.map((severity, index) => ({
          source: 2000 + index,
          name: "aggregate-package",
          dependency: "aggregate-package",
          title: `aggregate-package ${severity} advisory`,
          url: `https://github.com/advisories/GHSA-${2000 + index}`,
          severity,
          range: "<1.0.0",
        })),
        effects: [],
        range: "<1.0.0",
        nodes: ["node_modules/aggregate-package"],
        fixAvailable: false,
      },
    },
    metadata: {
      vulnerabilities: { ...counters, total: 1 },
      dependencies: {
        prod: 1,
        dev: 0,
        optional: 0,
        peer: 0,
        peerOptional: 0,
        total: 1,
      },
    },
  });
};

describe("production dependency audit gate", () => {
  it("fails closed on malformed npm audit JSON", () => {
    expect(() => inspectProductionAudit("not-json", emptyAllowlist(), NOW))
      .toThrow(/malformed npm audit output/i);
  });

  it.each([
    ["missing", (counters: Record<string, unknown>) => { delete counters.critical; }],
    ["non-integer", (counters: Record<string, unknown>) => { counters.high = "1"; }],
    ["negative", (counters: Record<string, unknown>) => { counters.high = -1; }],
  ])("fails closed when a metadata vulnerability counter is %s", (_label, mutate) => {
    const parsed = JSON.parse(auditOutput([])) as {
      metadata: { vulnerabilities: Record<string, unknown> };
    };
    mutate(parsed.metadata.vulnerabilities);

    expect(() => inspectProductionAudit(JSON.stringify(parsed), emptyAllowlist(), NOW))
      .toThrow(/malformed npm audit output.*metadata vulnerability counters/i);
  });

  it("fails closed when metadata counters contradict vulnerable package records", () => {
    const parsed = JSON.parse(auditOutput([{
      id: 1234,
      package: "unsafe-package",
      severity: "high",
    }])) as {
      metadata: { vulnerabilities: Record<string, unknown> };
    };
    parsed.metadata.vulnerabilities.high = 0;
    parsed.metadata.vulnerabilities.total = 0;

    expect(() => inspectProductionAudit(JSON.stringify(parsed), emptyAllowlist(), NOW))
      .toThrow(/malformed npm audit output.*contradictory metadata vulnerability counters/i);
  });

  it("validates metadata against vulnerable packages, not deduplicated advisories", () => {
    const allowlist = {
      version: 1,
      entries: [{
        advisoryId: "1234",
        package: "leaf-package",
        owner: "security@example.com",
        justification: "Transitive mitigation while upgrading the parent",
        expiry: "2026-08-01",
      }],
    };

    const report = inspectProductionAudit(transitiveAuditOutput(), allowlist, NOW);

    expect(report.passed).toBe(true);
    expect(report.advisories).toHaveLength(1);
    expect(report.summary.high).toBe(1);
  });

  it("rejects an allowlisted high cause when its vulnerable package claims critical", () => {
    const allowlist = {
      version: 1,
      entries: [{
        advisoryId: "1234",
        package: "leaf-package",
        owner: "security@example.com",
        justification: "High advisory is temporarily mitigated",
        expiry: "2026-08-01",
      }],
    };

    expect(() => inspectProductionAudit(
      transitiveAuditOutput("critical", "high"),
      allowlist,
      NOW,
    )).toThrow(/aggregate severity critical.*reachable advisory maximum high/i);
  });

  it.each([
    ["moderate", "low"],
    ["moderate", "critical"],
  ] as const)(
    "rejects aggregate severity %s when reachable advisory maximum is %s",
    (aggregateSeverity, causeSeverity) => {
      expect(() => inspectProductionAudit(
        aggregateAuditOutput(aggregateSeverity, [causeSeverity]),
        emptyAllowlist(),
        NOW,
      )).toThrow(new RegExp(
        `aggregate severity ${aggregateSeverity}.*reachable advisory maximum ${causeSeverity}`,
        "i",
      ));
    },
  );

  it("accepts an aggregate severity equal to the maximum of mixed reachable causes", () => {
    const report = inspectProductionAudit(
      aggregateAuditOutput("critical", ["moderate", "critical", "high"]),
      emptyAllowlist(),
      NOW,
    );

    expect(report.advisories.map(({ severity }) => severity)).toEqual([
      "moderate",
      "critical",
      "high",
    ]);
    expect(report.summary).toMatchObject({ moderate: 1, high: 1, critical: 1 });
  });

  it("rejects malformed allowlist entries", () => {
    const allowlist = {
      version: 1,
      entries: [{
        advisoryId: "1234",
        package: "unsafe-package",
        owner: "",
        justification: "Temporary mitigation",
        expiry: "2026-08-01",
      }],
    };

    expect(() => inspectProductionAudit(auditOutput([]), allowlist, NOW))
      .toThrow(/malformed audit allowlist/i);
  });

  it("rejects every expired allowlist entry, even when it is unused", () => {
    const allowlist = {
      version: 1,
      entries: [{
        advisoryId: "1234",
        package: "unsafe-package",
        owner: "security@example.com",
        justification: "Temporary mitigation while upgrading",
        expiry: "2026-07-13",
      }],
    };

    expect(() => inspectProductionAudit(auditOutput([]), allowlist, NOW))
      .toThrow(/expired audit allowlist entry/i);
  });

  it.each(["high", "critical"] as const)(
    "blocks an unallowlisted %s production advisory",
    (severity) => {
      const report = inspectProductionAudit(auditOutput([{
        id: 1234,
        package: "unsafe-package",
        severity,
      }]), emptyAllowlist(), NOW);

      expect(report.passed).toBe(false);
      expect(report.blockingAdvisories).toEqual([expect.objectContaining({
        advisoryId: "1234",
        package: "unsafe-package",
        severity,
        allowlisted: false,
      })]);
    },
  );

  it("reports moderate and low advisories without making them release-blocking", () => {
    const report = inspectProductionAudit(auditOutput([
      { id: 1234, package: "moderate-package", severity: "moderate" },
      { id: 5678, package: "low-package", severity: "low" },
    ]), emptyAllowlist(), NOW);

    expect(report.passed).toBe(true);
    expect(report.blockingAdvisories).toEqual([]);
    expect(report.advisories.map(({ advisoryId, severity }) => ({ advisoryId, severity })))
      .toEqual([
        { advisoryId: "5678", severity: "low" },
        { advisoryId: "1234", severity: "moderate" },
      ]);
  });

  it("passes an explicitly allowlisted high advisory", () => {
    const allowlist = {
      version: 1,
      entries: [{
        advisoryId: "1234",
        package: "unsafe-package",
        owner: "security@example.com",
        justification: "Mitigated at the application boundary while upgrading",
        expiry: "2026-08-01",
      }],
    };

    const report = inspectProductionAudit(auditOutput([{
      id: 1234,
      package: "unsafe-package",
      severity: "high",
    }]), allowlist, NOW);

    expect(report.passed).toBe(true);
    expect(report.blockingAdvisories).toEqual([]);
    expect(report.advisories).toEqual([expect.objectContaining({ allowlisted: true })]);
  });
});
