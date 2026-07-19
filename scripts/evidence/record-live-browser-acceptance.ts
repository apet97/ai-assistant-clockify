import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  recordLiveBrowserAcceptanceEvidence,
  type LiveBrowserAcceptanceEvidence,
} from "./live-browser-acceptance.js";

const MAX_INPUT_BYTES = 1_048_576;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

export interface LiveBrowserRecorderInput {
  tracePath: string;
  memberDenialPath: string;
  deployedVersionPath: string;
  outputPath: string;
  expectedCandidateSha: string;
  worktreeRoot?: string;
}

function outside(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child);
}

function readSafeBytes(path: string, label: string, worktreeRoot: string): Buffer {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size > MAX_INPUT_BYTES
    || !outside(realpathSync(absolute), worktreeRoot)
  ) throw new Error(`${label} is unsafe`);
  return readFileSync(absolute);
}

function parse(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

function writeAtomic(path: string, value: unknown, worktreeRoot: string): void {
  const absolute = resolve(path);
  const realWorktreeRoot = realpathSync(worktreeRoot);
  let existingAncestor = dirname(absolute);
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error("browser recorder output is unsafe");
    existingAncestor = parent;
  }
  const ancestorInfo = lstatSync(existingAncestor);
  if (!ancestorInfo.isDirectory()) throw new Error("browser recorder output is unsafe");
  const projectedOutput = resolve(
    realpathSync(existingAncestor),
    relative(existingAncestor, absolute),
  );
  if (!outside(projectedOutput, realWorktreeRoot)) {
    throw new Error("browser recorder output must be outside the worktree");
  }
  if (existsSync(absolute)) {
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("browser recorder output is unsafe");
  }
  mkdirSync(dirname(absolute), { recursive: true });
  // Re-resolve after mkdir so a missing descendant or symlinked ancestor cannot
  // redirect the subsequent temporary write back into the real worktree.
  const actualOutput = resolve(realpathSync(dirname(absolute)), basename(absolute));
  if (!outside(actualOutput, realWorktreeRoot)) {
    throw new Error("browser recorder output must be outside the worktree");
  }
  const temporary = `${absolute}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, absolute);
}

/** Record final browser evidence without allowing the automation result to
 * author release identity, member binding, or its own capture digest. */
export function recordLiveBrowserAcceptanceFromFiles(
  input: LiveBrowserRecorderInput,
): LiveBrowserAcceptanceEvidence {
  if (!SHA_PATTERN.test(input.expectedCandidateSha)) throw new Error("browser recorder candidate is malformed");
  const worktreeRoot = realpathSync(resolve(input.worktreeRoot ?? process.cwd()));
  const traceBytes = readSafeBytes(input.tracePath, "sanitized browser trace", worktreeRoot);
  const memberBytes = readSafeBytes(input.memberDenialPath, "member-denial evidence", worktreeRoot);
  const deployedBytes = readSafeBytes(input.deployedVersionPath, "deployed version evidence", worktreeRoot);
  const evidence = recordLiveBrowserAcceptanceEvidence({
    trace: parse(traceBytes, "sanitized browser trace"),
    traceSha256: createHash("sha256").update(traceBytes).digest("hex"),
    memberDenialEvidence: parse(memberBytes, "member-denial evidence"),
    deployedVersion: parse(deployedBytes, "deployed version evidence"),
    expectedCandidateSha: input.expectedCandidateSha,
  });
  writeAtomic(input.outputPath, evidence, worktreeRoot);
  return evidence;
}

const CLI_FLAGS = {
  "--trace": "tracePath",
  "--member-denial": "memberDenialPath",
  "--deployed-version": "deployedVersionPath",
  "--expected-candidate": "expectedCandidateSha",
  "--output": "outputPath",
} as const;

function parseCli(argv: string[]): Omit<LiveBrowserRecorderInput, "worktreeRoot"> {
  const parsed: Partial<Omit<LiveBrowserRecorderInput, "worktreeRoot">> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] as keyof typeof CLI_FLAGS | undefined;
    const value = argv[index + 1];
    const key = flag === undefined ? undefined : CLI_FLAGS[flag];
    if (!key || !value || value.startsWith("--") || parsed[key] !== undefined) {
      throw new Error("invalid browser recorder arguments");
    }
    parsed[key] = value;
  }
  for (const key of Object.values(CLI_FLAGS)) {
    if (!parsed[key]) throw new Error("missing browser recorder argument");
  }
  return parsed as Omit<LiveBrowserRecorderInput, "worktreeRoot">;
}

function main(): void {
  if (process.versions.node.split(".")[0] !== "22") throw new Error("Node 22 required");
  recordLiveBrowserAcceptanceFromFiles({
    ...parseCli(process.argv.slice(2)),
    worktreeRoot: process.cwd(),
  });
  process.stdout.write("Production browser evidence recorded.\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stderr.write("Production browser evidence recording failed.\n");
    process.exitCode = 1;
  }
}
