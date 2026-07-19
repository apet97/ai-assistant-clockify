import { afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";

import { buildManifest } from "../../src/addon/manifest.js";
import { ClockifyHeaders, createSignatureParser } from "../../src/addon/verify.js";
import { hashCanonicalAttestationJson } from "../../src/addon/install-attestation.js";
import { createStore, type Store } from "../../src/db/store.js";
import { createApp } from "../../src/server.js";
import { createWorkspaceMutationCoordinator } from "../../src/clockify/workspace-mutation-coordinator.js";
import type { RuntimeReleaseArtifactIdentity } from "../../src/release-artifact.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { makeTestConfig } from "../helpers/config.js";
import { testKeys } from "../helpers/test-keys.js";

const ADDON_KEY = "ai-assistant";
const BASE_URL = "https://example.com/ai-assistant";
const SESSION_SECRET = "test-session-secret-for-attestation-signatures";
const IDENTITY: RuntimeReleaseArtifactIdentity = {
  releaseSha: "a".repeat(40),
  releaseBuildHash: "b".repeat(64),
  serverArtifactSha256: "c".repeat(64),
  sourceRelationship: "source_bound_builder",
  sourceBindingSha256: "d".repeat(64),
};

const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({ kind: "answer", text: "unused" });
  },
};

let keys: { privateKey: unknown; pem: string };
let stores: Store[] = [];

beforeAll(async () => {
  keys = await testKeys();
});

afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function appFor(identity: RuntimeReleaseArtifactIdentity = IDENTITY) {
  const config = makeTestConfig({
    baseUrl: BASE_URL,
    sessionSecret: SESSION_SECRET,
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  const store = createStore(":memory:", { encryptionKey: "attestation-test-key" });
  stores.push(store);
  const fake = createFakeWorkspace();
  const mutationCoordinator = createWorkspaceMutationCoordinator();
  return {
    store,
    mutationCoordinator,
    app: createApp({
      config,
      store,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => fake.client,
      releaseArtifactIdentity: identity,
      mutationCoordinator,
    }),
  };
}

async function lifecycleToken(
  workspaceId: string,
  iat = Math.floor(Date.now() / 1000),
): Promise<string> {
  return testing.signTestToken(keys.privateKey, ADDON_KEY, {
    iat,
    workspaceId,
    addonId: ADDON_KEY,
    backendUrl: "https://api.clockify.me/api",
  });
}

async function install(
  app: ReturnType<typeof appFor>["app"],
  workspaceId: string,
  addonToken: string,
  iat?: number,
) {
  return request(app)
    .post("/lifecycle/installed")
    .set(ClockifyHeaders.LIFECYCLE_TOKEN, await lifecycleToken(workspaceId, iat))
    .send({ workspaceId, addonId: ADDON_KEY, authToken: addonToken });
}

async function uninstall(
  app: ReturnType<typeof appFor>["app"],
  workspaceId: string,
  iat?: number,
) {
  return request(app)
    .post("/lifecycle/deleted")
    .set(ClockifyHeaders.LIFECYCLE_TOKEN, await lifecycleToken(workspaceId, iat))
    .send({ workspaceId, addonId: ADDON_KEY });
}

async function setStatus(
  app: ReturnType<typeof appFor>["app"],
  workspaceId: string,
  status: "ACTIVE" | "INACTIVE",
  iat?: number,
) {
  return request(app)
    .post("/lifecycle/status-changed")
    .set(ClockifyHeaders.LIFECYCLE_TOKEN, await lifecycleToken(workspaceId, iat))
    .send({ workspaceId, addonId: ADDON_KEY, status });
}

function getAttestation(app: ReturnType<typeof appFor>["app"], workspaceId: string, token: string) {
  return request(app)
    .get(`/release/install-attestation/${encodeURIComponent(workspaceId)}`)
    .set("X-Addon-Token", token);
}

describe("fresh-install release attestation routes", () => {
  it("mints only after a verified fresh lifecycle callback and verifies a secret-free envelope", async () => {
    const { app } = appFor();
    const workspaceId = "ws-fresh-release-proof";
    const addonToken = "fresh-production-addon-token";
    expect((await install(app, workspaceId, addonToken)).status).toBe(200);

    const response = await getAttestation(app, workspaceId, addonToken);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toMatchObject({
      method: "authenticated_server_installation_attestation",
      installationGeneration: 1,
      releaseSha: IDENTITY.releaseSha,
      releaseBuildHash: IDENTITY.releaseBuildHash,
      serverArtifactSha256: IDENTITY.serverArtifactSha256,
      sourceRelationship: IDENTITY.sourceRelationship,
      sourceBindingSha256: IDENTITY.sourceBindingSha256,
      manifestSha256: hashCanonicalAttestationJson(buildManifest(BASE_URL)),
    });
    expect(response.body.workspaceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(response.body.attestationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(response.body.verificationEnvelope).toBeTypeOf("object");
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(workspaceId);
    expect(serialized).not.toContain(addonToken);
    expect(serialized).not.toContain(SESSION_SECRET);

    const verified = await request(app)
      .post("/release/install-attestation/verify")
      .send(response.body.verificationEnvelope);
    expect(verified.status).toBe(200);
    expect(verified.headers["cache-control"]).toBe("no-store");
    expect(verified.body).toEqual({
      valid: true,
      attestationSha256: response.body.attestationSha256,
      releaseSha: IDENTITY.releaseSha,
      releaseBuildHash: IDENTITY.releaseBuildHash,
      serverArtifactSha256: IDENTITY.serverArtifactSha256,
      sourceRelationship: IDENTITY.sourceRelationship,
      sourceBindingSha256: IDENTITY.sourceBindingSha256,
      manifestSha256: response.body.manifestSha256,
    });
    expect(JSON.stringify(verified.body)).not.toMatch(/workspace|token|secret/iu);
  });

  it("keeps the fresh proof and generation stable across concurrent same-token callback retries", async () => {
    const { app, store } = appFor();
    const workspaceId = "ws-retried-fresh-proof";
    const addonToken = "same-token-delivered-again";
    const initialIat = Math.floor(Date.now() / 1000) - 60;
    expect((await install(app, workspaceId, addonToken, initialIat)).status).toBe(200);

    const first = await getAttestation(app, workspaceId, addonToken);
    expect(first.status).toBe(200);

    const retries = await Promise.all([
      install(app, workspaceId, addonToken, initialIat + 30),
      install(app, workspaceId, addonToken, initialIat + 60),
    ]);
    expect(retries.map((response) => response.status)).toEqual([200, 200]);
    expect(store.getInstallation(workspaceId)?.generation).toBe(1);
    expect(store.getInstallation(workspaceId)?.lifecycleIssuedAt).toBe(initialIat);

    const afterRetries = await getAttestation(app, workspaceId, addonToken);
    expect(afterRetries.status).toBe(200);
    expect(afterRetries.body.attestationSha256).toBe(first.body.attestationSha256);
    expect(afterRetries.body.verificationEnvelope).toEqual(first.body.verificationEnvelope);
  });

  it("returns one indistinguishable failure for a wrong token or workspace", async () => {
    const { app } = appFor();
    await install(app, "ws-owned", "owned-token");

    const wrongToken = await getAttestation(app, "ws-owned", "wrong-token");
    const wrongWorkspace = await getAttestation(app, "ws-other", "owned-token");
    expect(wrongToken.status).toBe(404);
    expect(wrongWorkspace.status).toBe(404);
    expect(wrongToken.body).toEqual({ ok: false, code: "attestation_unavailable" });
    expect(wrongWorkspace.body).toEqual(wrongToken.body);
  });

  it("invalidates the fresh proof on token replacement and does not mint a replacement proof", async () => {
    const { app, store } = appFor();
    const workspaceId = "ws-token-replacement";
    const nowSeconds = Math.floor(Date.now() / 1000);
    await install(app, workspaceId, "token-one", nowSeconds - 2);
    expect((await getAttestation(app, workspaceId, "token-one")).status).toBe(200);

    await install(app, workspaceId, "token-two", nowSeconds - 1);
    expect((await getAttestation(app, workspaceId, "token-one")).status).toBe(404);
    expect((await getAttestation(app, workspaceId, "token-two")).status).toBe(404);

    // An older callback delivered after the replacement cannot rotate the
    // workspace back to retired authority.
    expect((await install(app, workspaceId, "token-one", nowSeconds)).status).toBe(200);
    expect(store.getInstallation(workspaceId)).toMatchObject({
      addonToken: "token-two",
      generation: 2,
      status: "active",
    });
  });

  it("does not reactivate coordinator authority when a retired token is replayed against an inactive install", async () => {
    const { app, store, mutationCoordinator } = appFor();
    const workspaceId = "ws-inactive-retired-replay";
    const nowSeconds = Math.floor(Date.now() / 1000);
    await install(app, workspaceId, "retired-token-one", nowSeconds - 3);
    await install(app, workspaceId, "current-token-two", nowSeconds - 2);
    expect((await setStatus(app, workspaceId, "INACTIVE", nowSeconds - 1)).status).toBe(200);

    const replay = await install(app, workspaceId, "retired-token-one", nowSeconds);
    expect(replay.status).toBe(200);
    expect(store.getInstallation(workspaceId)).toMatchObject({
      addonToken: "current-token-two",
      generation: 2,
      status: "inactive",
    });
    expect(() => mutationCoordinator.acquire(workspaceId, 2)).toThrow();
  });

  it("removes the attestation immediately on uninstall", async () => {
    const { app, store } = appFor();
    const workspaceId = "ws-attestation-uninstall";
    const nowSeconds = Math.floor(Date.now() / 1000);
    await install(app, workspaceId, "uninstall-token", nowSeconds - 3);
    expect((await getAttestation(app, workspaceId, "uninstall-token")).status).toBe(200);
    expect((await uninstall(app, workspaceId, nowSeconds - 2)).status).toBe(200);
    expect((await getAttestation(app, workspaceId, "uninstall-token")).status).toBe(404);

    // A delayed redelivery of the old, still-signature-valid callback must not
    // resurrect the erased installation or mint a new release proof.
    expect((await install(app, workspaceId, "uninstall-token", nowSeconds - 1)).status).toBe(200);
    expect(store.getInstallation(workspaceId)).toBeUndefined();
    expect((await getAttestation(app, workspaceId, "uninstall-token")).status).toBe(404);

    // A real reinstall receives a new platform token and remains allowed.
    expect((await install(app, workspaceId, "fresh-reinstall-token", nowSeconds)).status).toBe(200);
    expect(store.getInstallation(workspaceId)?.addonToken).toBe("fresh-reinstall-token");
    expect((await getAttestation(app, workspaceId, "fresh-reinstall-token")).status).toBe(200);
  });

  it("rejects arbitrary or tampered envelopes and envelopes for another deployed release", async () => {
    const { app } = appFor();
    await install(app, "ws-tamper", "tamper-token");
    const minted = await getAttestation(app, "ws-tamper", "tamper-token");
    const envelope = minted.body.verificationEnvelope;

    for (const invalid of [
      { payload: envelope.payload },
      { ...envelope, operatorAssertion: true },
      { ...envelope, payload: { ...envelope.payload, releaseSha: "f".repeat(40) } },
    ]) {
      const response = await request(app).post("/release/install-attestation/verify").send(invalid);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ valid: false });
    }

    const other = appFor({ ...IDENTITY, releaseSha: "9".repeat(40) });
    const wrongRelease = await request(other.app)
      .post("/release/install-attestation/verify")
      .send(envelope);
    expect(wrongRelease.status).toBe(400);
    expect(wrongRelease.body).toEqual({ valid: false });
  });
});
