import { writeDeterministicJson } from "./write-json.js";

const COUNT_KEYS = ["created", "matched", "removed", "remaining", "failures", "scanFailures"] as const;

interface LiveEvidenceInput {
  resourcePrefixes: string[];
  counts: Record<string, unknown>;
  passed: boolean;
}

export interface LiveEvidence {
  resourcePrefixes: string[];
  counts: Partial<Record<(typeof COUNT_KEYS)[number], number>>;
  status: "passed" | "failed";
}

function normalizedPrefixes(prefixes: string[]): string[] {
  const unique = [...new Set(prefixes)].sort();
  if (unique.length === 0 || unique.some((prefix) => !/^AIASSIST_[A-Z0-9_]*_$/.test(prefix))) {
    throw new Error("live evidence requires an approved resource prefix");
  }
  return unique;
}

function normalizedCounts(input: Record<string, unknown>): LiveEvidence["counts"] {
  const counts: LiveEvidence["counts"] = {};
  for (const key of COUNT_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`live evidence count ${key} must be a non-negative safe integer`);
    }
    counts[key] = value as number;
  }
  return counts;
}

export function buildLiveEvidence(input: LiveEvidenceInput): LiveEvidence {
  return {
    resourcePrefixes: normalizedPrefixes(input.resourcePrefixes),
    counts: normalizedCounts(input.counts),
    status: input.passed ? "passed" : "failed",
  };
}

export function writeLiveEvidence(path: string, input: LiveEvidenceInput): void {
  writeDeterministicJson(path, buildLiveEvidence(input));
}
