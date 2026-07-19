import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  renderPrivateProductionMarkdown,
  type PrivateProductionEvidence,
} from "../performance/private-production-contract.js";
import {
  validatePrivateProductionReleaseEvidence,
  type PrivateProductionReleaseValidation,
} from "./private-production-release-evidence.js";
import {
  validateOperationalReleaseEvidence,
  type OperationalReleaseEvidence,
} from "./operational-release-evidence.js";
import {
  validateLiveBrowserAcceptanceEvidenceWithTrace,
  type LiveBrowserAcceptanceEvidence,
  type LiveBrowserAcceptanceValidation,
  type MemberDenialEvidence,
} from "./live-browser-acceptance.js";

const MAX_INPUT_BYTES = 1_048_576;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

type JsonObject = Record<string, unknown>;

export const CANONICAL_RELEASE_EVIDENCE_PATHS = {
  privateProduction: "evidence/performance/private-production.json",
  privateProductionMarkdown: "evidence/performance/private-production.md",
  restore: "evidence/operations/production-restore.json",
  scope: "evidence/operations/production-scope-probe.json",
  browser: "evidence/operations/production-browser.json",
  browserTrace: "evidence/operations/production-browser-trace.json",
  memberDenial: "evidence/operations/production-member-denial.json",
} as const;

export interface ReleaseEvidenceImportInput {
  root: string;
  sourceCandidateSha: string;
  privateProductionPath: string;
  restorePath: string;
  scopePath: string;
  browserPath: string;
  browserTracePath: string;
  memberDenialPath: string;
  deployedVersionPath: string;
  deployedManifestPath: string;
  attestationVerificationPath: string;
}

export interface ReleaseEvidenceImportResult {
  privateProduction: PrivateProductionEvidence;
  restore: JsonObject;
  scope: JsonObject;
  browser: LiveBrowserAcceptanceEvidence;
  memberDenial: MemberDenialEvidence;
  privateProductionValidation: PrivateProductionReleaseValidation;
  operationalValidation: OperationalReleaseEvidence;
  liveBrowserValidation: LiveBrowserAcceptanceValidation;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function readBoundedBytes(path: string, label: string): Buffer {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} is missing, unsafe, or too large`);
  }
  return readFileSync(absolute);
}

function readBoundedJson(path: string, label: string): JsonObject {
  try {
    const bytes = readBoundedBytes(path, label);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return object(JSON.parse(text) as unknown, label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function canonicalObject(value: JsonObject): JsonObject {
  return canonicalize(value) as JsonObject;
}

function writeCanonicalFiles(
  root: string,
  files: ReadonlyArray<readonly [string, string | Uint8Array]>,
): void {
  const pending: Array<{ target: string; temporary: string }> = [];
  try {
    for (const [relativePath, contents] of files) {
      const target = resolve(root, relativePath);
      const temporary = `${target}.importing`;
      mkdirSync(dirname(target), { recursive: true });
      rmSync(temporary, { force: true });
      writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
      pending.push({ target, temporary });
    }
    for (const { target, temporary } of pending) renameSync(temporary, target);
  } finally {
    for (const { temporary } of pending) rmSync(temporary, { force: true });
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Validate all timestamped operator outputs before opening any canonical target,
 * then normalize them into the only checked-in filenames consumed by CI. */
export function importReleaseEvidence(input: ReleaseEvidenceImportInput): ReleaseEvidenceImportResult {
  if (!SHA_PATTERN.test(input.sourceCandidateSha)) {
    throw new Error("source candidate SHA must be a full lowercase commit SHA");
  }
  const privateProductionInput = readBoundedJson(input.privateProductionPath, "private-production source evidence");
  const restoreInput = readBoundedJson(input.restorePath, "restore source evidence");
  const scopeInput = readBoundedJson(input.scopePath, "scope source evidence");
  const browserInput = readBoundedJson(input.browserPath, "browser source evidence");
  const browserTraceBytes = readBoundedBytes(input.browserTracePath, "browser trace source evidence");
  const memberDenialInput = readBoundedJson(input.memberDenialPath, "member-denial source evidence");
  const deployedVersion = readBoundedJson(input.deployedVersionPath, "deployed version evidence");
  const deployedManifest = readBoundedJson(input.deployedManifestPath, "deployed manifest evidence");
  const attestationVerification = readBoundedJson(
    input.attestationVerificationPath,
    "attestation verification evidence",
  );

  const privateProductionValidation = validatePrivateProductionReleaseEvidence({
    evidence: privateProductionInput,
    deployedVersion,
    expectedCandidateSha: input.sourceCandidateSha,
  });
  const operationalValidation = validateOperationalReleaseEvidence({
    sourceCandidateSha: input.sourceCandidateSha,
    evidenceCommitSha: input.sourceCandidateSha,
    deployedVersion,
    deployedManifest,
    attestationVerification,
    restoreEvidence: restoreInput,
    scopeEvidence: scopeInput,
  });
  const liveBrowserValidation = validateLiveBrowserAcceptanceEvidenceWithTrace({
    evidence: browserInput,
    traceBytes: browserTraceBytes,
    memberDenialEvidence: memberDenialInput,
    deployedVersion,
    expectedCandidateSha: input.sourceCandidateSha,
  });

  const privateProduction = canonicalObject(privateProductionInput) as unknown as PrivateProductionEvidence;
  const restore = canonicalObject(restoreInput);
  const scope = canonicalObject(scopeInput);
  const browser = canonicalObject(browserInput) as unknown as LiveBrowserAcceptanceEvidence;
  const memberDenial = canonicalObject(memberDenialInput) as unknown as MemberDenialEvidence;
  writeCanonicalFiles(input.root, [
    [CANONICAL_RELEASE_EVIDENCE_PATHS.privateProduction, json(privateProduction)],
    [CANONICAL_RELEASE_EVIDENCE_PATHS.privateProductionMarkdown, renderPrivateProductionMarkdown(privateProduction)],
    [CANONICAL_RELEASE_EVIDENCE_PATHS.restore, json(restore)],
    [CANONICAL_RELEASE_EVIDENCE_PATHS.scope, json(scope)],
    [CANONICAL_RELEASE_EVIDENCE_PATHS.browser, json(browser)],
    [CANONICAL_RELEASE_EVIDENCE_PATHS.browserTrace, browserTraceBytes],
    [CANONICAL_RELEASE_EVIDENCE_PATHS.memberDenial, json(memberDenial)],
  ]);
  return {
    privateProduction,
    restore,
    scope,
    browser,
    memberDenial,
    privateProductionValidation,
    operationalValidation,
    liveBrowserValidation,
  };
}

const CLI_FLAGS = {
  "--source-candidate": "sourceCandidateSha",
  "--private-production": "privateProductionPath",
  "--restore": "restorePath",
  "--scope": "scopePath",
  "--browser": "browserPath",
  "--browser-trace": "browserTracePath",
  "--member-denial": "memberDenialPath",
  "--deployed-version": "deployedVersionPath",
  "--deployed-manifest": "deployedManifestPath",
  "--attestation-verification": "attestationVerificationPath",
} as const;

function parseCli(argv: string[]): Omit<ReleaseEvidenceImportInput, "root"> {
  const parsed: Partial<Omit<ReleaseEvidenceImportInput, "root">> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] as keyof typeof CLI_FLAGS | undefined;
    const value = argv[index + 1];
    const key = flag === undefined ? undefined : CLI_FLAGS[flag];
    if (!key || !value || value.startsWith("--") || parsed[key] !== undefined) {
      throw new Error("invalid release-evidence import arguments");
    }
    parsed[key] = value;
  }
  for (const key of Object.values(CLI_FLAGS)) {
    if (!parsed[key]) throw new Error(`missing release-evidence import argument: ${key}`);
  }
  return parsed as Omit<ReleaseEvidenceImportInput, "root">;
}

function main(): void {
  const result = importReleaseEvidence({ root: process.cwd(), ...parseCli(process.argv.slice(2)) });
  process.stdout.write(
    `Imported candidate-bound release evidence for ${result.operationalValidation.sourceCandidateSha}.\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : "release-evidence import failed"}\n`);
    process.exitCode = 1;
  }
}
