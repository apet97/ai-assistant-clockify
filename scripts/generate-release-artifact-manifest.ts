import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  writeSourceBoundBuilderReleaseArtifactManifest,
  writeReleaseArtifactManifest,
} from "./lib/release-artifact-identity.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const manifest = writeReleaseArtifactManifest({
    repositoryRoot,
    sourceCandidateSha: process.env.RELEASE_SHA,
  });
  process.stdout.write(
    `release artifact manifest: ${manifest.sourceRelationship} ${manifest.serverArtifactSha256}\n`,
  );
} catch {
  // Railway and package-tarball builders intentionally receive no `.git`
  // directory. Their runtime identity still comes from the release variables;
  // the restore drill runs this build in the exact Git checkout and requires
  // the bound manifest before it may spawn the one-off server.
  if (!existsSync(resolve(repositoryRoot, ".git"))) {
    if (
      process.env.RELEASE_SHA
      && process.env.RELEASE_BUILD_HASH
      && process.env.RELEASE_SOURCE_BINDING_SHA256
    ) {
      try {
        const manifest = writeSourceBoundBuilderReleaseArtifactManifest({
          repositoryRoot,
          releaseSha: process.env.RELEASE_SHA,
          releaseBuildHash: process.env.RELEASE_BUILD_HASH,
          sourceBindingSha256: process.env.RELEASE_SOURCE_BINDING_SHA256,
        });
        process.stdout.write(
          `release artifact manifest: source_bound_builder ${manifest.serverArtifactSha256}\n`,
        );
      } catch {
        process.stderr.write("Release artifact manifest generation failed.\n");
        process.exitCode = 1;
      }
    } else {
      process.stdout.write("release artifact manifest: skipped (Git metadata or source binding unavailable)\n");
    }
  } else {
    process.stderr.write("Release artifact manifest generation failed.\n");
    process.exitCode = 1;
  }
}
