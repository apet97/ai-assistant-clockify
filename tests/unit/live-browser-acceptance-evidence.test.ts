import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  recordLiveBrowserAcceptanceEvidence,
  validateLiveBrowserAcceptanceEvidence,
  validateLiveBrowserAcceptanceEvidenceWithTrace,
  type LiveBrowserAcceptanceEvidence,
  type MemberDenialEvidence,
} from "../../scripts/evidence/live-browser-acceptance.js";
import {
  runMemberDenialProbe,
  type MemberDenialProbeFetch,
} from "../../scripts/live-member-denial-probe.js";
import { hashCanonicalJson } from "../../scripts/lib/live-evidence.js";

const SHA = {
  candidate: "a".repeat(40),
  archive: "b".repeat(64),
  server: "c".repeat(64),
  sourceBinding: "d".repeat(64),
  capture: "e".repeat(64),
};
const PRODUCTION_ORIGIN = "https://ai-assistant-production-c2e6.up.railway.app";

const source = {
  commitSha: SHA.candidate,
  releaseBuildHash: SHA.archive,
  serverArtifactSha256: SHA.server,
  sourceRelationship: "source_bound_builder" as const,
  sourceBindingSha256: SHA.sourceBinding,
};

function deployedVersion() {
  return {
    version: "1.0.0",
    releaseSha: SHA.candidate,
    buildHash: SHA.archive,
    serverArtifactSha256: SHA.server,
    sourceRelationship: "source_bound_builder",
    sourceBindingSha256: SHA.sourceBinding,
  };
}

function memberDenialEvidence(): MemberDenialEvidence {
  return {
    schemaVersion: 1,
    kind: "production_member_denial",
    conclusion: "passed",
    source,
    observedAt: "2026-07-19T10:05:00.000Z",
    role: "MEMBER",
    authorityPath: "verified_installation_to_member_exchange",
    componentStatus: 403,
    sessionCookieIssued: false,
    adminOnlyResponse: true,
  };
}

function browserEvidence(member = memberDenialEvidence()): LiveBrowserAcceptanceEvidence {
  return {
    schemaVersion: 1,
    kind: "production_browser_acceptance",
    conclusion: "passed",
    source,
    startedAt: "2026-07-19T10:00:00.000Z",
    completedAt: "2026-07-19T10:10:00.000Z",
    deployedVersionObservedAt: "2026-07-19T10:00:01.000Z",
    runtime: {
      browser: "Google Chrome",
      browserVersion: "140.0.7339.42",
      surface: "clockify_embedded_iframe",
    },
    journeys: {
      firstRun: { disclosureVisible: true, permissionsSaved: true, permissionGroupCount: 13 },
      admin: { componentLoaded: true, role: "OWNER" },
      read: { receiptVisible: true },
      safeWrite: { receiptVisible: true },
      undo: { receiptVisible: true, effectAbsent: true },
      riskyCancel: { previewVisible: true, cancelled: true, effectPreserved: true },
      riskyConfirm: { previewVisible: true, confirmed: true, receiptVisible: true, effectAbsent: true },
      history: { conversationSwitched: true, contentRestored: true },
      reload: { contentRestored: true, operationCardsRestored: true },
      pdf: {
        actionVisible: true,
        downloadCompleted: true,
        filenameExtension: ".pdf",
        contentType: "application/pdf",
        signature: "%PDF-",
        bytes: 128,
        authenticatedStatus: 200,
        unauthenticatedStatus: 401,
      },
    },
    cleanup: {
      resourcePrefix: "AIASSIST_SMOKE_",
      created: 4,
      deletionProven: 4,
      remaining: 0,
      pendingPreviews: 0,
    },
    capture: {
      artifactType: "browser_automation_trace",
      sha256: SHA.capture,
      secretReview: "passed",
    },
    memberDenialEvidenceSha256: hashCanonicalJson(member),
  };
}

function sanitizedTrace() {
  const evidence = browserEvidence();
  return {
    schemaVersion: 1,
    kind: "sanitized_browser_automation_trace",
    startedAt: evidence.startedAt,
    completedAt: evidence.completedAt,
    deployedVersionObservedAt: evidence.deployedVersionObservedAt,
    runtime: evidence.runtime,
    journeys: evidence.journeys,
    cleanup: evidence.cleanup,
  };
}

describe("production browser acceptance evidence", () => {
  it("classifies existing conclusions as historical v1 evidence and rejects v2 reuse without changing hashes", () => {
    const member = memberDenialEvidence();
    const artifact = browserEvidence(member);
    const artifactHash = hashCanonicalJson(artifact);

    expect(validateLiveBrowserAcceptanceEvidence({
      evidence: artifact,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    }, "v1")).toMatchObject({
      assistantEngine: "v1",
      evidenceStatus: "historical",
      validForV2: false,
    });
    expect(() => validateLiveBrowserAcceptanceEvidence({
      evidence: artifact,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    }, "v2")).toThrow(/historical v1 evidence is not valid for v2/iu);
    expect(hashCanonicalJson(artifact)).toBe(artifactHash);
  });

  it("records final evidence from one strict sanitized automation result without hand-authored source binding", () => {
    const member = memberDenialEvidence();
    const recorded = recordLiveBrowserAcceptanceEvidence({
      trace: sanitizedTrace(),
      traceSha256: SHA.capture,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    });

    expect(recorded).toEqual(browserEvidence(member));
    expect(validateLiveBrowserAcceptanceEvidence({
      evidence: recorded,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toMatchObject({ conclusion: "passed", journeyCount: 10 });

    const tainted = { ...sanitizedTrace(), componentUrl: "https://private.example/component" };
    expect(() => recordLiveBrowserAcceptanceEvidence({
      trace: tainted,
      traceSha256: SHA.capture,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toThrow(/secret|keys/u);
  });

  it("requires the retained strict trace bytes to reproduce the final evidence exactly", () => {
    const member = memberDenialEvidence();
    const traceBytes = Buffer.from(`${JSON.stringify(sanitizedTrace(), null, 2)}\n`, "utf8");
    const traceHash = createHash("sha256").update(traceBytes).digest("hex");
    const evidence = recordLiveBrowserAcceptanceEvidence({
      trace: sanitizedTrace(),
      traceSha256: traceHash,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    });

    expect(validateLiveBrowserAcceptanceEvidenceWithTrace({
      evidence,
      traceBytes,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toMatchObject({ conclusion: "passed", captureSha256: traceHash });

    const mismatchedTrace = structuredClone(sanitizedTrace());
    mismatchedTrace.journeys.read.receiptVisible = false as true;
    const mismatchedBytes = Buffer.from(`${JSON.stringify(mismatchedTrace, null, 2)}\n`, "utf8");
    expect(() => validateLiveBrowserAcceptanceEvidenceWithTrace({
      evidence,
      traceBytes: mismatchedBytes,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toThrow(/trace|capture|read|match/u);

    const secretTrace = { ...sanitizedTrace(), componentUrl: "https://private.example/component?auth_token=secret" };
    expect(() => validateLiveBrowserAcceptanceEvidenceWithTrace({
      evidence,
      traceBytes: Buffer.from(JSON.stringify(secretTrace), "utf8"),
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toThrow(/trace|secret|keys/u);
  });

  it("requires every production journey and binds it to the exact deployed candidate", () => {
    const member = memberDenialEvidence();
    expect(validateLiveBrowserAcceptanceEvidence({
      evidence: browserEvidence(member),
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toMatchObject({
      schemaVersion: 1,
      conclusion: "passed",
      sourceCandidateSha: SHA.candidate,
      browser: "Google Chrome",
      journeyCount: 10,
      memberDenial: "passed",
      cleanup: { created: 4, deletionProven: 4, remaining: 0, pendingPreviews: 0 },
    });
  });

  it("rejects a missing journey, weak PDF proof, incomplete cleanup, or a different deployment", () => {
    const member = memberDenialEvidence();

    const missing = structuredClone(browserEvidence(member)) as unknown as Record<string, unknown>;
    delete (missing.journeys as Record<string, unknown>).undo;
    expect(() => validateLiveBrowserAcceptanceEvidence({
      evidence: missing,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toThrow(/journey|keys/u);

    const weakPdf = structuredClone(browserEvidence(member)) as unknown as {
      journeys: { pdf: { unauthenticatedStatus: number } };
    };
    weakPdf.journeys.pdf.unauthenticatedStatus = 200;
    expect(() => validateLiveBrowserAcceptanceEvidence({
      evidence: weakPdf,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toThrow(/PDF/u);

    const dirty = structuredClone(browserEvidence(member)) as unknown as {
      cleanup: { remaining: number };
    };
    dirty.cleanup.remaining = 1;
    expect(() => validateLiveBrowserAcceptanceEvidence({
      evidence: dirty,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toThrow(/cleanup/u);

    expect(() => validateLiveBrowserAcceptanceEvidence({
      evidence: browserEvidence(member),
      memberDenialEvidence: member,
      deployedVersion: { ...deployedVersion(), serverArtifactSha256: "0".repeat(64) },
      expectedCandidateSha: SHA.candidate,
    })).toThrow(/artifact|deployment/u);
  });

  it("rejects secret-bearing or identifier-bearing additions and an unbound member proof", () => {
    const member = memberDenialEvidence();
    const tainted = structuredClone(browserEvidence(member)) as unknown as Record<string, unknown>;
    tainted.componentUrl = "https://private.example/component/assistant?auth_token=secret";
    expect(() => validateLiveBrowserAcceptanceEvidence({
      evidence: tainted,
      memberDenialEvidence: member,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toThrow(/secret|keys/u);

    const unbound = structuredClone(member);
    unbound.observedAt = "2026-07-19T11:00:00.000Z";
    expect(() => validateLiveBrowserAcceptanceEvidence({
      evidence: browserEvidence(member),
      memberDenialEvidence: unbound,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: SHA.candidate,
    })).toThrow(/member|time|hash/u);
  });
});

type FakeResponse = {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

function response(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

describe("production member-denial probe", () => {
  it("uses the installation-to-user exchange, proves 403/no-cookie, and emits no credential or identifier", async () => {
    const addonCredential = "eyJinstall.payload.signature";
    const memberCredential = "eyJmember.payload.signature";
    const workspaceIdentifier = "workspace-secret-id";
    const memberIdentifier = "member-secret-id";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const replies = [
      response(200, deployedVersion()),
      response(200, [{
        id: memberIdentifier,
        memberships: [{
          targetId: workspaceIdentifier,
          membershipType: "WORKSPACE",
          membershipStatus: "ACTIVE",
        }],
        roles: [],
      }]),
      response(200, JSON.stringify(memberCredential)),
      response(403, "This add-on is available to Clockify admins and owners only."),
    ];
    const fetchImpl: MemberDenialProbeFetch = async (url, init) => {
      requests.push({ url: String(url), init });
      const next = replies.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };

    const evidence = await runMemberDenialProbe({
      addonBaseUrl: PRODUCTION_ORIGIN,
      backendUrl: "https://developer.clockify.me/api",
      workspaceId: workspaceIdentifier,
      addonCredential,
      expectedSource: source,
      now: () => new Date("2026-07-19T10:05:00.000Z"),
      fetchImpl,
    });

    expect(requests).toHaveLength(4);
    expect(requests[1]?.init?.headers).toMatchObject({ "X-Addon-Token": addonCredential });
    expect(requests[2]?.url).toContain(`/addon/user/${memberIdentifier}/token`);
    expect(requests[3]?.url).toContain("/component/assistant?auth_token=");
    expect(evidence).toMatchObject({
      conclusion: "passed",
      role: "MEMBER",
      componentStatus: 403,
      sessionCookieIssued: false,
      adminOnlyResponse: true,
    });
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [addonCredential, memberCredential, workspaceIdentifier, memberIdentifier, "https://"] as const) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed when there is no explicit active member or the rejection issues a cookie", async () => {
    const noMember: MemberDenialProbeFetch = async (url) => String(url).endsWith("/version")
      ? response(200, deployedVersion())
      : response(200, []);
    await expect(runMemberDenialProbe({
      addonBaseUrl: PRODUCTION_ORIGIN,
      backendUrl: "https://developer.clockify.me/api",
      workspaceId: "workspace",
      addonCredential: "credential",
      expectedSource: source,
      now: () => new Date("2026-07-19T10:05:00.000Z"),
      fetchImpl: noMember,
    })).rejects.toThrow(/^member_denial_probe_failed$/u);

    const replies = [
      response(200, deployedVersion()),
      response(200, [{ id: "member", status: "ACTIVE", role: "MEMBER", roles: [] }]),
      response(200, JSON.stringify("member-credential")),
      response(403, "admins and owners only", { "set-cookie": "ai_assistant_session=forbidden" }),
    ];
    await expect(runMemberDenialProbe({
      addonBaseUrl: PRODUCTION_ORIGIN,
      backendUrl: "https://developer.clockify.me/api",
      workspaceId: "workspace",
      addonCredential: "credential",
      expectedSource: source,
      now: () => new Date("2026-07-19T10:05:00.000Z"),
      fetchImpl: async () => replies.shift()!,
    })).rejects.toThrow(/^member_denial_probe_failed$/u);
  });

  it.each([
    "https://assistant.example.test",
    "https://attacker-production.up.railway.app",
    `${PRODUCTION_ORIGIN}:443`,
    `${PRODUCTION_ORIGIN}:8443`,
    `${PRODUCTION_ORIGIN}/preview`,
    `${PRODUCTION_ORIGIN}?target=preview`,
    `${PRODUCTION_ORIGIN}#preview`,
    "https://operator@ai-assistant-production-c2e6.up.railway.app",
  ])("rejects an untrusted or non-root production origin before any request: %s", async (addonBaseUrl) => {
    let requests = 0;
    await expect(runMemberDenialProbe({
      addonBaseUrl,
      backendUrl: "https://developer.clockify.me/api",
      workspaceId: "workspace",
      addonCredential: "credential",
      expectedSource: source,
      now: () => new Date("2026-07-19T10:05:00.000Z"),
      fetchImpl: async () => {
        requests += 1;
        return response(200, deployedVersion());
      },
    })).rejects.toThrow(/^member_denial_probe_failed$/u);
    expect(requests).toBe(0);
  });
});
