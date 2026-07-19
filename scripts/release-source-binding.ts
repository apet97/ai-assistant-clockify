import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyReleaseSourceBinding,
  writeReleaseSourceBindingFromGit,
} from "./lib/release-artifact-identity.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseSha = process.env.RELEASE_SHA;
const releaseBuildHash = process.env.RELEASE_BUILD_HASH;
const sourceBindingSha256 = process.env.RELEASE_SOURCE_BINDING_SHA256;

try {
  if (process.argv[2] === "--write") {
    const sourceRoot = process.argv[3];
    if (!sourceRoot || !releaseSha || !releaseBuildHash) throw new Error("write_inputs_required");
    const result = writeReleaseSourceBindingFromGit({
      repositoryRoot,
      sourceRoot: resolve(sourceRoot),
      sourceCandidateSha: releaseSha,
      releaseBuildHash,
    });
    process.stdout.write(`${result.sha256}\n`);
  } else if (existsSync(resolve(repositoryRoot, ".git"))) {
    // Local exact/evidence-descendant builds get stronger Git provenance from
    // the post-build manifest generator; no transported binding is needed.
    process.stdout.write("release source binding: local Git checkout\n");
  } else if (releaseSha && releaseBuildHash && sourceBindingSha256) {
    const verified = verifyReleaseSourceBinding({
      sourceRoot: repositoryRoot,
      releaseSha,
      releaseBuildHash,
      sourceBindingSha256,
    });
    process.stdout.write(`release source binding: verified ${verified.sha256}\n`);
  } else if (process.env.NODE_ENV === "production" || releaseSha || releaseBuildHash || sourceBindingSha256) {
    throw new Error("source_binding_required");
  } else {
    process.stdout.write("release source binding: skipped (non-production source package)\n");
  }
} catch {
  process.stderr.write("Release source binding verification failed.\n");
  process.exitCode = 1;
}
