import parseSpdx from "spdx-expression-parse";

import {
  compareText,
  isRecord,
  requireExactKeys,
  requireNonEmptyString,
  requireUnexpiredDate,
} from "./policy.js";

type LicenseBlockReason = "forbidden_license" | "unknown_or_unparseable";

interface LicenseException {
  package: string;
  license: string;
  owner: string;
  justification: string;
  expiry: string;
}

interface InstalledPackage {
  package: string;
  version: string;
  license: string;
}

export interface ProductionLicensePackage extends InstalledPackage {
  status: "allowed" | "exception" | "blocked";
  reason?: LicenseBlockReason;
  exception?: {
    owner: string;
    justification: string;
    expiry: string;
  };
}

export interface ProductionLicenseReport {
  schemaVersion: 1;
  passed: boolean;
  packages: ProductionLicensePackage[];
  blockingPackages: ProductionLicensePackage[];
  summary: {
    allowed: number;
    exceptions: number;
    blocked: number;
  };
}

function malformedTree(detail: string): never {
  throw new Error(`Malformed npm production tree: ${detail}`);
}

function parseLicenseExceptions(input: unknown, now: Date): LicenseException[] {
  if (!isRecord(input)) {
    throw new Error("Malformed license exceptions: expected an object");
  }
  requireExactKeys(input, ["version", "entries"], "license exceptions");
  if (input.version !== 1 || !Array.isArray(input.entries)) {
    throw new Error("Malformed license exceptions: expected version 1 and an entries array");
  }

  const seen = new Set<string>();
  return input.entries.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`Malformed license exception ${index}: expected an object`);
    }
    requireExactKeys(
      raw,
      ["package", "license", "owner", "justification", "expiry"],
      `license exception ${index}`,
    );
    const exception = {
      package: requireNonEmptyString(raw.package, `license exception ${index}`),
      license: requireNonEmptyString(raw.license, `license exception ${index}`),
      owner: requireNonEmptyString(raw.owner, `license exception ${index}`),
      justification: requireNonEmptyString(raw.justification, `license exception ${index}`),
      expiry: requireUnexpiredDate(
        raw.expiry,
        now,
        `license exception ${index}`,
        `Expired license exception ${index}`,
      ),
    };
    const key = `${exception.package}\0${exception.license}`;
    if (seen.has(key)) {
      throw new Error(`Malformed license exceptions: duplicate entry for ${exception.package} / ${exception.license}`);
    }
    seen.add(key);
    return exception;
  });
}

function normalizeLicense(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "UNKNOWN";
}

function parseProductionTree(npmLsJson: string): InstalledPackage[] {
  let root: unknown;
  try {
    root = JSON.parse(npmLsJson) as unknown;
  } catch {
    return malformedTree("invalid JSON");
  }
  if (!isRecord(root)) return malformedTree("expected an object");
  if (Array.isArray(root.problems) && root.problems.length > 0) {
    return malformedTree("npm reported dependency problems");
  }

  const installed = new Map<string, InstalledPackage>();
  const visitDependencies = (dependencies: unknown, parent: string): void => {
    if (dependencies === undefined) return;
    if (!isRecord(dependencies)) return malformedTree(`${parent} dependencies are not an object`);

    for (const [edge, value] of Object.entries(dependencies)) {
      if (!isRecord(value)) return malformedTree(`${parent} dependency ${edge} is not an object`);
      if (value.missing === true || value.invalid === true || value.extraneous === true || value.dev === true) {
        return malformedTree(`${parent} dependency ${edge} is not a valid production install`);
      }
      const packageName = typeof value.name === "string" && value.name.trim().length > 0
        ? value.name.trim()
        : malformedTree(`${parent} dependency ${edge} has no package name`);
      const version = typeof value.version === "string" && value.version.trim().length > 0
        ? value.version.trim()
        : malformedTree(`${parent} dependency ${edge} has no version`);
      const current = {
        package: packageName,
        version,
        license: normalizeLicense(value.license),
      };
      const key = `${packageName}\0${version}`;
      const existing = installed.get(key);
      if (existing !== undefined && existing.license !== current.license) {
        return malformedTree(`${packageName}@${version} has conflicting licenses`);
      }
      installed.set(key, current);
      visitDependencies(value.dependencies, `${packageName}@${version}`);
    }
  };

  visitDependencies(root.dependencies, "root");
  return [...installed.values()].sort((left, right) => compareText(left.package, right.package)
    || compareText(left.version, right.version)
    || compareText(left.license, right.license));
}

function licenseIdentifiers(node: parseSpdx.Info): string[] {
  if ("license" in node) return [node.license];
  return [...licenseIdentifiers(node.left), ...licenseIdentifiers(node.right)];
}

function classifyLicense(license: string): LicenseBlockReason | undefined {
  if (license === "UNKNOWN") return "unknown_or_unparseable";
  let parsed: parseSpdx.Info;
  try {
    parsed = parseSpdx(license);
  } catch {
    return "unknown_or_unparseable";
  }
  const identifiers = licenseIdentifiers(parsed);
  if (identifiers.some((identifier) => identifier.startsWith("LicenseRef-")
    || identifier.startsWith("DocumentRef-"))) {
    return "unknown_or_unparseable";
  }
  if (identifiers.some((identifier) => identifier.startsWith("GPL-3.0")
    || identifier.startsWith("AGPL-"))) {
    return "forbidden_license";
  }
  return undefined;
}

export function inspectProductionLicenses(
  npmLsJson: string,
  exceptionsInput: unknown,
  now: Date,
): ProductionLicenseReport {
  const exceptions = parseLicenseExceptions(exceptionsInput, now);
  const exceptionByKey = new Map(exceptions.map((entry) => [
    `${entry.package}\0${entry.license}`,
    entry,
  ]));
  const packages = parseProductionTree(npmLsJson).map((installed): ProductionLicensePackage => {
    const reason = classifyLicense(installed.license);
    if (reason === undefined) return { ...installed, status: "allowed" };

    const exception = exceptionByKey.get(`${installed.package}\0${installed.license}`);
    if (exception !== undefined) {
      return {
        ...installed,
        status: "exception",
        exception: {
          owner: exception.owner,
          justification: exception.justification,
          expiry: exception.expiry,
        },
      };
    }
    return { ...installed, status: "blocked", reason };
  });
  const blockingPackages = packages.filter(({ status }) => status === "blocked");

  return {
    schemaVersion: 1,
    passed: blockingPackages.length === 0,
    packages,
    blockingPackages,
    summary: {
      allowed: packages.filter(({ status }) => status === "allowed").length,
      exceptions: packages.filter(({ status }) => status === "exception").length,
      blocked: blockingPackages.length,
    },
  };
}
