import {
  compareText,
  isRecord,
  requireExactKeys,
  requireNonEmptyString,
  requireUnexpiredDate,
} from "./policy.js";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;

type Severity = typeof SEVERITIES[number];
type VulnerabilityCounters = Record<Severity | "total", number>;
const SEVERITY_RANK = new Map<Severity, number>(SEVERITIES.map((severity, index) => [severity, index]));

interface AuditAllowlistEntry {
  advisoryId: string;
  package: string;
  owner: string;
  justification: string;
  expiry: string;
}

interface RawAuditAdvisory {
  advisoryId: string;
  package: string;
  severity: Severity;
  title: string;
  url: string;
}

interface RawVulnerability {
  severity: Severity;
  via: Array<string | RawAuditAdvisory>;
}

export interface ProductionAuditAdvisory extends RawAuditAdvisory {
  allowlisted: boolean;
}

export interface ProductionAuditReport {
  schemaVersion: 1;
  passed: boolean;
  advisories: ProductionAuditAdvisory[];
  blockingAdvisories: ProductionAuditAdvisory[];
  summary: Record<Severity, number>;
}

function malformedAudit(detail: string): never {
  throw new Error(`Malformed npm audit output: ${detail}`);
}

function parseSeverity(value: unknown, detail: string): Severity {
  if (typeof value !== "string" || !SEVERITIES.includes(value as Severity)) {
    return malformedAudit(`${detail} has an invalid severity`);
  }
  return value as Severity;
}

function parseAuditAllowlist(input: unknown, now: Date): AuditAllowlistEntry[] {
  if (!isRecord(input)) {
    throw new Error("Malformed audit allowlist: expected an object");
  }
  requireExactKeys(input, ["version", "entries"], "audit allowlist");
  if (input.version !== 1 || !Array.isArray(input.entries)) {
    throw new Error("Malformed audit allowlist: expected version 1 and an entries array");
  }

  const seen = new Set<string>();
  return input.entries.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`Malformed audit allowlist entry ${index}: expected an object`);
    }
    requireExactKeys(
      raw,
      ["advisoryId", "package", "owner", "justification", "expiry"],
      `audit allowlist entry ${index}`,
    );
    const entry = {
      advisoryId: requireNonEmptyString(raw.advisoryId, `audit allowlist entry ${index}`),
      package: requireNonEmptyString(raw.package, `audit allowlist entry ${index}`),
      owner: requireNonEmptyString(raw.owner, `audit allowlist entry ${index}`),
      justification: requireNonEmptyString(raw.justification, `audit allowlist entry ${index}`),
      expiry: requireUnexpiredDate(
        raw.expiry,
        now,
        `audit allowlist entry ${index}`,
        `Expired audit allowlist entry ${index}`,
      ),
    };
    const key = `${entry.advisoryId}\0${entry.package}`;
    if (seen.has(key)) {
      throw new Error(`Malformed audit allowlist: duplicate entry for ${entry.advisoryId} / ${entry.package}`);
    }
    seen.add(key);
    return entry;
  });
}

function parseAuditAdvisory(value: Record<string, unknown>, detail: string): RawAuditAdvisory {
  const source = value.source;
  if ((typeof source !== "string" && typeof source !== "number")
    || String(source).trim().length === 0) {
    return malformedAudit(`${detail} has no advisory source`);
  }
  return {
    advisoryId: String(source).trim(),
    package: typeof value.name === "string" && value.name.trim().length > 0
      ? value.name.trim()
      : malformedAudit(`${detail} has no package name`),
    severity: parseSeverity(value.severity, detail),
    title: typeof value.title === "string" && value.title.trim().length > 0
      ? value.title.trim()
      : malformedAudit(`${detail} has no title`),
    url: typeof value.url === "string" && value.url.trim().length > 0
      ? value.url.trim()
      : malformedAudit(`${detail} has no URL`),
  };
}

function parseVulnerabilityCounters(metadata: Record<string, unknown>): VulnerabilityCounters {
  if (!isRecord(metadata.vulnerabilities)) {
    return malformedAudit("metadata vulnerability counters are missing");
  }
  const expected = [...SEVERITIES, "total"].sort();
  const actual = Object.keys(metadata.vulnerabilities).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return malformedAudit(`metadata vulnerability counters must contain exactly ${expected.join(", ")}`);
  }

  const counters = metadata.vulnerabilities as Record<string, unknown>;
  for (const key of expected) {
    if (!Number.isSafeInteger(counters[key]) || (counters[key] as number) < 0) {
      return malformedAudit(`metadata vulnerability counters.${key} must be a non-negative integer`);
    }
  }
  const parsed = counters as VulnerabilityCounters;
  const severityTotal = SEVERITIES.reduce((total, severity) => total + parsed[severity], 0);
  if (parsed.total !== severityTotal) {
    return malformedAudit("contradictory metadata vulnerability counters: total does not equal severity counts");
  }
  return parsed;
}

function parseAuditJson(auditJson: string): Map<string, RawVulnerability> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(auditJson) as unknown;
  } catch {
    return malformedAudit("invalid JSON");
  }
  if (!isRecord(parsed)
    || parsed.auditReportVersion !== 2
    || !isRecord(parsed.vulnerabilities)
    || !isRecord(parsed.metadata)) {
    return malformedAudit("expected audit report version 2 with vulnerabilities and metadata");
  }
  const counters = parseVulnerabilityCounters(parsed.metadata);

  const vulnerabilities = new Map<string, RawVulnerability>();
  for (const [key, value] of Object.entries(parsed.vulnerabilities)) {
    if (!isRecord(value)
      || typeof value.name !== "string"
      || value.name.trim().length === 0
      || !Array.isArray(value.via)
      || value.via.length === 0) {
      return malformedAudit(`vulnerability ${key} is incomplete`);
    }
    const via = value.via.map((cause, index) => {
      if (typeof cause === "string" && cause.trim().length > 0) return cause.trim();
      if (isRecord(cause)) return parseAuditAdvisory(cause, `vulnerability ${key} via[${index}]`);
      return malformedAudit(`vulnerability ${key} via[${index}] is invalid`);
    });
    vulnerabilities.set(key, {
      severity: parseSeverity(value.severity, `vulnerability ${key}`),
      via,
    });
  }
  const packageCounts = Object.fromEntries(SEVERITIES.map((severity) => [
    severity,
    [...vulnerabilities.values()].filter((vulnerability) => vulnerability.severity === severity).length,
  ])) as Record<Severity, number>;
  // npm metadata counts vulnerable package records, not deduplicated advisory causes.
  if (SEVERITIES.some((severity) => counters[severity] !== packageCounts[severity])
    || counters.total !== vulnerabilities.size) {
    return malformedAudit("contradictory metadata vulnerability counters: counts do not match vulnerable packages");
  }
  return vulnerabilities;
}

function collectAdvisories(vulnerabilities: Map<string, RawVulnerability>): RawAuditAdvisory[] {
  const collected = new Map<string, RawAuditAdvisory>();

  const visit = (name: string, stack: Set<string>): RawAuditAdvisory[] => {
    if (stack.has(name)) return malformedAudit(`cyclic vulnerability reference at ${name}`);
    const vulnerability = vulnerabilities.get(name);
    if (vulnerability === undefined) {
      return malformedAudit(`vulnerability ${name} references a missing vulnerability`);
    }
    const nextStack = new Set(stack).add(name);
    const causes = vulnerability.via.flatMap((cause) => typeof cause === "string"
      ? visit(cause, nextStack)
      : [cause]);
    const maximumCauseSeverity = causes.reduce((maximum, cause) => (
      (SEVERITY_RANK.get(cause.severity) ?? -1) > (SEVERITY_RANK.get(maximum) ?? -1)
        ? cause.severity
        : maximum
    ), causes[0].severity);
    if (vulnerability.severity !== maximumCauseSeverity) {
      return malformedAudit(
        `vulnerability ${name} aggregate severity ${vulnerability.severity} does not match reachable advisory maximum ${maximumCauseSeverity}`,
      );
    }
    return causes;
  };

  for (const name of vulnerabilities.keys()) {
    for (const advisory of visit(name, new Set())) {
      const key = `${advisory.advisoryId}\0${advisory.package}`;
      const existing = collected.get(key);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(advisory)) {
        return malformedAudit(`advisory ${advisory.advisoryId} has conflicting records`);
      }
      collected.set(key, advisory);
    }
  }
  return [...collected.values()].sort((left, right) => compareText(left.package, right.package)
    || compareText(left.advisoryId, right.advisoryId));
}

export function inspectProductionAudit(
  auditJson: string,
  allowlistInput: unknown,
  now: Date,
): ProductionAuditReport {
  const allowlist = parseAuditAllowlist(allowlistInput, now);
  const allowlistedKeys = new Set(allowlist.map((entry) => `${entry.advisoryId}\0${entry.package}`));
  const advisories = collectAdvisories(parseAuditJson(auditJson)).map((advisory) => ({
    ...advisory,
    allowlisted: allowlistedKeys.has(`${advisory.advisoryId}\0${advisory.package}`),
  }));
  const blockingAdvisories = advisories.filter(({ allowlisted, severity }) => !allowlisted
    && (severity === "high" || severity === "critical"));
  const summary = Object.fromEntries(SEVERITIES.map((severity) => [
    severity,
    advisories.filter((advisory) => advisory.severity === severity).length,
  ])) as Record<Severity, number>;

  return {
    schemaVersion: 1,
    passed: blockingAdvisories.length === 0,
    advisories,
    blockingAdvisories,
    summary,
  };
}
