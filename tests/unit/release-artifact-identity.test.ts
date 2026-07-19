import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyBuiltReleaseArtifact,
  writeReleaseSourceBindingFromGit,
  writeReleaseArtifactManifest,
  writeSourceBoundBuilderReleaseArtifactManifest,
} from "../../scripts/lib/release-artifact-identity.js";
import { verifyRuntimeReleaseArtifact } from "../../src/release-artifact.js";

const temporaryDirectories: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function releaseFixture(): {
  root: string;
  releaseSha: string;
  releaseBuildHash: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ai-assistant-release-artifact-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dist", "server"), { recursive: true });
  mkdirSync(join(root, "dist", "ui"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "src", "server.ts"), "export const release = 'candidate';\n");
  writeFileSync(join(root, "package.json"), "{\"private\":true}\n");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "tsconfig.build.json"), "{}\n");
  writeFileSync(join(root, "vite.config.ts"), "export default {};\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Restore Test"]);
  git(root, ["config", "user.email", "restore-test@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "candidate"]);
  const releaseSha = git(root, ["rev-parse", "HEAD"]);
  const archive = execFileSync("git", ["archive", "--format=tar", releaseSha], { cwd: root });
  const releaseBuildHash = createHash("sha256").update(archive).digest("hex");
  writeFileSync(join(root, "dist", "server", "server.js"), "export const release = 'candidate';\n");
  writeFileSync(join(root, "dist", "ui", "index.html"), "<!doctype html><script src=\"/ui/main.js\"></script>\n");
  writeFileSync(join(root, "dist", "ui", "index.css"), "body { color: black; }\n");
  writeFileSync(join(root, "dist", "ui", "main.js"), "document.body.textContent = 'candidate';\n");
  writeReleaseArtifactManifest({ repositoryRoot: root, sourceCandidateSha: releaseSha });
  return { root, releaseSha, releaseBuildHash };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("built release artifact identity", () => {
  it("binds the exact Git candidate, archive, and complete generated runtime trees", () => {
    const fixture = releaseFixture();

    const proof = verifyBuiltReleaseArtifact({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    });

    expect(proof).toMatchObject({
      sourceCandidateSha: fixture.releaseSha,
      sourceArchiveSha256: fixture.releaseBuildHash,
      serverArtifact: "dist/server",
      sourceRelationship: "exact_head",
    });
    expect(proof.serverArtifactSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not let the same built artifact pass under an arbitrary SHA and archive hash", () => {
    const fixture = releaseFixture();

    expect(() => verifyBuiltReleaseArtifact({
      repositoryRoot: fixture.root,
      releaseSha: "a".repeat(40),
      releaseBuildHash: "b".repeat(64),
    })).toThrowError(expect.objectContaining({ code: "release_identity_mismatch" }));
  });

  it("fails production preflight when arbitrary environment identity claims reuse the same bytes", () => {
    const fixture = releaseFixture();

    expect(() => verifyRuntimeReleaseArtifact({
      repositoryRoot: fixture.root,
      nodeEnv: "production",
      releaseSha: "a".repeat(40),
      releaseBuildHash: "b".repeat(64),
    })).toThrowError(expect.objectContaining({ code: "release_identity_mismatch" }));

    expect(verifyRuntimeReleaseArtifact({
      repositoryRoot: fixture.root,
      nodeEnv: "production",
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    })).toMatchObject({
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceRelationship: "exact_head",
    });
  });

  it("lets a source-bound Git-less deployment prove runtime bytes but never promotes it to restore proof", () => {
    const fixture = releaseFixture();
    const sourceBinding = writeReleaseSourceBindingFromGit({
      repositoryRoot: fixture.root,
      sourceRoot: fixture.root,
      sourceCandidateSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    });
    const sourcePath = join(fixture.root, "src", "server.ts");
    const candidateSource = "export const release = 'candidate';\n";
    writeFileSync(sourcePath, "export const release = 'different upload';\n");
    expect(() => writeSourceBoundBuilderReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceBindingSha256: sourceBinding.sha256,
    })).toThrowError(expect.objectContaining({ code: "source_tree_mismatch" }));
    writeFileSync(sourcePath, candidateSource);
    writeSourceBoundBuilderReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceBindingSha256: sourceBinding.sha256,
    });

    expect(verifyRuntimeReleaseArtifact({
      repositoryRoot: fixture.root,
      nodeEnv: "production",
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceBindingSha256: sourceBinding.sha256,
    })).toMatchObject({
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: sourceBinding.sha256,
    });
    expect(() => verifyBuiltReleaseArtifact({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    })).toThrowError(expect.objectContaining({ code: "source_candidate_unbound" }));
  });

  it("ignores only the exact Nixpacks metadata generated before the Railway build", () => {
    const fixture = releaseFixture();
    const sourceBinding = writeReleaseSourceBindingFromGit({
      repositoryRoot: fixture.root,
      sourceRoot: fixture.root,
      sourceCandidateSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    });
    mkdirSync(join(fixture.root, ".nixpacks"), { recursive: true });
    writeFileSync(join(fixture.root, ".nixpacks", "Dockerfile"), "# generated by Nixpacks\n");
    writeFileSync(join(fixture.root, ".nixpacks", "build.sh"), "#!/usr/bin/env bash\n");
    writeFileSync(
      join(fixture.root, ".nixpacks", `nixpkgs-${"a".repeat(40)}.nix`),
      "# generated Nix package pin\n",
    );

    expect(() => writeSourceBoundBuilderReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceBindingSha256: sourceBinding.sha256,
    })).not.toThrow();

    writeFileSync(join(fixture.root, ".nixpacks", "unrecognized-source.ts"), "export const hidden = true;\n");
    expect(() => writeSourceBoundBuilderReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceBindingSha256: sourceBinding.sha256,
    })).toThrowError(expect.objectContaining({ code: "source_tree_mismatch" }));

    rmSync(join(fixture.root, ".nixpacks", "unrecognized-source.ts"));
    writeFileSync(join(fixture.root, ".nixpacks", ".payload"), "hidden builder-adjacent source\n");
    expect(() => writeSourceBoundBuilderReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceBindingSha256: sourceBinding.sha256,
    })).toThrowError(expect.objectContaining({ code: "source_tree_mismatch" }));

    rmSync(join(fixture.root, ".nixpacks", ".payload"));
    writeFileSync(join(fixture.root, ".railway-injected.ts"), "export const hidden = true;\n");
    expect(() => writeSourceBoundBuilderReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceBindingSha256: sourceBinding.sha256,
    })).toThrowError(expect.objectContaining({ code: "source_tree_mismatch" }));
  });

  it("does not hide source nested below an allowlisted Nixpacks filename", () => {
    const fixture = releaseFixture();
    const sourceBinding = writeReleaseSourceBindingFromGit({
      repositoryRoot: fixture.root,
      sourceRoot: fixture.root,
      sourceCandidateSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    });
    mkdirSync(join(fixture.root, ".nixpacks", "Dockerfile"), { recursive: true });
    writeFileSync(
      join(fixture.root, ".nixpacks", "Dockerfile", "payload.ts"),
      "export const hidden = true;\n",
    );

    expect(() => writeSourceBoundBuilderReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceBindingSha256: sourceBinding.sha256,
    })).toThrowError(expect.objectContaining({ code: "source_tree_mismatch" }));
  });

  it("does not hide an allowlisted Nixpacks path when it is a symlink", () => {
    const fixture = releaseFixture();
    const sourceBinding = writeReleaseSourceBindingFromGit({
      repositoryRoot: fixture.root,
      sourceRoot: fixture.root,
      sourceCandidateSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    });
    mkdirSync(join(fixture.root, ".nixpacks"), { recursive: true });
    symlinkSync("../src/server.ts", join(fixture.root, ".nixpacks", "Dockerfile"));

    expect(() => writeSourceBoundBuilderReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
      sourceBindingSha256: sourceBinding.sha256,
    })).toThrowError(expect.objectContaining({ code: "source_tree_mismatch" }));
  });

  it("rejects any generated server byte changed after the deterministic manifest was written", () => {
    const fixture = releaseFixture();
    writeFileSync(join(fixture.root, "dist", "server", "server.js"), "export const release = 'tampered';\n");

    expect(() => verifyBuiltReleaseArtifact({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    })).toThrowError(expect.objectContaining({ code: "server_artifact_mismatch" }));
  });

  it("rejects any served UI byte changed after the deterministic manifest was written", () => {
    const fixture = releaseFixture();
    writeFileSync(join(fixture.root, "dist", "ui", "main.js"), "document.body.textContent = 'tampered';\n");

    expect(() => verifyBuiltReleaseArtifact({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    })).toThrowError(expect.objectContaining({ code: "server_artifact_mismatch" }));
    expect(() => verifyRuntimeReleaseArtifact({
      repositoryRoot: fixture.root,
      nodeEnv: "production",
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    })).toThrowError(expect.objectContaining({ code: "server_artifact_mismatch" }));
  });

  it("accepts a clean evidence-only descendant while retaining the source-candidate identity", () => {
    const fixture = releaseFixture();
    mkdirSync(join(fixture.root, "evidence"), { recursive: true });
    writeFileSync(join(fixture.root, "evidence", "restore-proof.json"), "{\"passed\":true}\n");
    git(fixture.root, ["add", "evidence/restore-proof.json"]);
    git(fixture.root, ["commit", "-qm", "immutable evidence"]);
    writeReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      sourceCandidateSha: fixture.releaseSha,
    });

    expect(verifyBuiltReleaseArtifact({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    })).toMatchObject({
      sourceCandidateSha: fixture.releaseSha,
      sourceRelationship: "evidence_descendant",
    });
  });

  it("rejects a descendant with any non-evidence source change", () => {
    const fixture = releaseFixture();
    writeFileSync(join(fixture.root, "src", "server.ts"), "export const release = 'changed';\n");
    git(fixture.root, ["add", "src/server.ts"]);
    git(fixture.root, ["commit", "-qm", "post-candidate source change"]);
    const manifest = writeReleaseArtifactManifest({
      repositoryRoot: fixture.root,
      sourceCandidateSha: fixture.releaseSha,
    });

    expect(manifest.sourceRelationship).toBe("unbound");
    expect(() => verifyBuiltReleaseArtifact({
      repositoryRoot: fixture.root,
      releaseSha: fixture.releaseSha,
      releaseBuildHash: fixture.releaseBuildHash,
    })).toThrowError(expect.objectContaining({ code: "source_candidate_unbound" }));
  });
});
