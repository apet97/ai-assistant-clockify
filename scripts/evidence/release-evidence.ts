import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { writeDeterministicJson } from "./write-json.js";

const MACHINE_GATE_KEYS = [
  "verify",
  "audit",
  "license",
  "codeql",
  "secretScan",
  "scriptedSafetyCorpus",
  "sbom",
  "liveSmoke",
] as const;

const HUMAN_GATE_KEYS = [
  "productionCredentialRotation",
  "providerDataGovernanceReview",
  "backupRestoreDrill",
  "deterministicSafetyEvaluation",
  "securityReview",
  "productionAuditHostClearance",
  "marketplaceApproval",
] as const;

type MachineGate = (typeof MACHINE_GATE_KEYS)[number];
type MachineStatus = "passed" | "failed" | "cancelled" | "skipped" | "unknown";

interface ReleaseEvidenceInput {
  commitSha: string;
  machineConclusions: Partial<Record<MachineGate, unknown>>;
}

export interface ReleaseEvidence {
  commitSha: string;
  machineGates: Record<MachineGate, MachineStatus>;
  humanGates: Record<(typeof HUMAN_GATE_KEYS)[number], "not_evaluated">;
}

function machineStatus(value: unknown): MachineStatus {
  switch (value) {
    case "success": return "passed";
    case "failure": return "failed";
    case "cancelled": return "cancelled";
    case "skipped": return "skipped";
    default: return "unknown";
  }
}

export function buildReleaseEvidence(input: ReleaseEvidenceInput): ReleaseEvidence {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.commitSha)) {
    throw new Error("release evidence requires a full lowercase commit SHA");
  }

  const machineGates = Object.fromEntries(MACHINE_GATE_KEYS.map((gate) => [
    gate,
    machineStatus(input.machineConclusions[gate]),
  ])) as ReleaseEvidence["machineGates"];
  const humanGates = Object.fromEntries(HUMAN_GATE_KEYS.map((gate) => [
    gate,
    "not_evaluated",
  ])) as ReleaseEvidence["humanGates"];

  return { commitSha: input.commitSha, machineGates, humanGates };
}

function main(): void {
  const outputPath = process.env.RELEASE_EVIDENCE_PATH;
  if (!outputPath) throw new Error("RELEASE_EVIDENCE_PATH is required");

  const evidence = buildReleaseEvidence({
    commitSha: process.env.RELEASE_COMMIT_SHA ?? "",
    machineConclusions: {
      verify: process.env.RELEASE_GATE_VERIFY,
      audit: process.env.RELEASE_GATE_AUDIT,
      license: process.env.RELEASE_GATE_LICENSE,
      codeql: process.env.RELEASE_GATE_CODEQL,
      secretScan: process.env.RELEASE_GATE_SECRET_SCAN,
      scriptedSafetyCorpus: process.env.RELEASE_GATE_SCRIPTED_SAFETY_CORPUS,
      sbom: process.env.RELEASE_GATE_SBOM,
      liveSmoke: process.env.RELEASE_GATE_LIVE_SMOKE,
    },
  });
  writeDeterministicJson(outputPath, evidence);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stderr.write("release evidence generation failed\n");
    process.exitCode = 1;
  }
}
