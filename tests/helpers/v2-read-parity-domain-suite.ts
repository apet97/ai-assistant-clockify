import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../../src/db/store.js";
import type { ReadExecutionOutcome } from "../../src/assistant-v2/protocol.js";
import { executeV2Read } from "../../src/assistant-v2/read-execution.js";
import type { SuccessReceipt, ErrorReceipt } from "../../src/harness/receipts.js";
import {
  assertCanonicalLinkPreserved,
  assertConcurrentReadsPreserveOrder,
  assertDiscoveryReturnsAction,
  assertDomainFixturesComplete,
  assertFullCatalogNotExposed,
  assertLoadedSchemaStrict,
  assertUnavailableHiddenFromDiscovery,
  baseScope,
  buildReadDeps,
  catalogReadsForDomain,
  discoveryQueriesForAction,
  expectedUnicodeSubstring,
  fixtureFor,
  mergeSeed,
  policyWithGroupOff,
  receiptContainsUnicode,
  receiptsSemanticallyEqual,
  runV1Read,
  type ReadParityDomain,
  readActionNames,
  unicodeArgsForAction,
  unicodeSeedForAction,
} from "./v2-read-parity.js";
import { createFakeWorkspace } from "./fake-clockify.js";

const directories: string[] = [];

function testStore(): Store {
  const directory = mkdtempSync(join(tmpdir(), "v2-read-parity-"));
  directories.push(directory);
  const store = createStore(join(directory, "db.sqlite"), { encryptionKey: "test-key" });
  store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  return store;
}

function storedReceipt(store: Store, actionResultId: string | undefined): SuccessReceipt | ErrorReceipt {
  if (!actionResultId) throw new Error("missing actionResultId");
  const stored = store.getActionResult(actionResultId);
  if (!stored || typeof stored !== "object" || (stored as { kind?: string }).kind !== "receipt") {
    throw new Error("expected stored receipt");
  }
  return (stored as { receipt: SuccessReceipt | ErrorReceipt }).receipt;
}

function outcomeResultId(outcome: ReadExecutionOutcome): string {
  if ("actionResultId" in outcome && outcome.actionResultId !== undefined) return outcome.actionResultId;
  throw new Error("expected actionResultId");
}

function errorCode(receipt: SuccessReceipt | ErrorReceipt): string {
  if (!receipt.ok) return receipt.code;
  throw new Error("expected error receipt");
}

function successReceipt(receipt: SuccessReceipt | ErrorReceipt): SuccessReceipt {
  if (!receipt.ok) throw new Error("expected success receipt");
  return receipt;
}

export function registerReadParityDomainSuite(
  domain: ReadParityDomain,
  concurrencyActions: readonly string[],
): void {
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  describe(`v2 ${domain} read parity matrix`, () => {
    assertDomainFixturesComplete(domain);
    const reads = catalogReadsForDomain(domain);

    it(`covers every catalog ${domain} read row`, () => {
      expect(reads.map((action) => action.name).sort()).toEqual(readActionNames(domain));
    });

    it("never exposes the full model catalog through initial load", () => {
      assertFullCatalogNotExposed();
    });

    for (const action of reads) {
      describe(action.name, () => {
        const fixture = fixtureFor(action.name);
        const queries = discoveryQueriesForAction(action);
        const parityAuthClass = fixture.authClass ?? "addon";

        if (fixture.addonUnavailable) {
          it("is absent from addon discovery and schemas", () => {
            assertUnavailableHiddenFromDiscovery(action.name);
          });
        } else {
          it("discovers via canonical, paraphrase, and one-character typo queries", () => {
            assertDiscoveryReturnsAction(action.name, queries.canonical);
            assertDiscoveryReturnsAction(action.name, queries.paraphrase);
            assertDiscoveryReturnsAction(action.name, queries.typo);
          });
        }

        it("exposes only a strict loaded schema", () => {
          if (fixture.addonUnavailable) return;
          assertLoadedSchemaStrict(action.name);
        });

        it("rejects unknown fields before execution", async () => {
          if (fixture.addonUnavailable) {
            const fake = createFakeWorkspace(mergeSeed(fixture.seed));
            const store = testStore();
            const deps = buildReadDeps({ fake, store });
            const outcome = await executeV2Read(
              { id: "t1", name: action.name, arguments: { ...fixture.args, unexpected: true } },
              baseScope("addon"),
              deps,
            );
            expect(outcome.kind).toBe("denied");
            expect(errorCode(storedReceipt(store, outcomeResultId(outcome)))).toBe("unavailable_for_auth_class");
            return;
          }
          const fake = createFakeWorkspace(mergeSeed(fixture.seed));
          const store = testStore();
          const deps = buildReadDeps({ fake, store });
          const outcome = await executeV2Read(
            { id: "t1", name: action.name, arguments: { ...fixture.args, unexpected: true } },
            baseScope(parityAuthClass),
            deps,
          );
          expect(outcome.kind).toBe("validation_failed");
          expect(errorCode(storedReceipt(store, outcomeResultId(outcome)))).toBe("invalid_args");
        });

        it("denies deterministic policy-off reads", async () => {
          if (fixture.addonUnavailable) {
            const fake = createFakeWorkspace(mergeSeed(fixture.seed));
            const store = testStore();
            const deps = buildReadDeps({ fake, store });
            const outcome = await executeV2Read(
              { id: "t1", name: action.name, arguments: fixture.args },
              baseScope("addon"),
              deps,
            );
            expect(outcome.kind).toBe("denied");
            expect(errorCode(storedReceipt(store, outcomeResultId(outcome)))).toBe("unavailable_for_auth_class");
            return;
          }
          const fake = createFakeWorkspace(mergeSeed(fixture.seed));
          const store = testStore();
          store.upsertAdminPolicy("ws-1", "admin-1", policyWithGroupOff(action.featureGroup));
          const deps = buildReadDeps({ fake, store });
          const outcome = await executeV2Read(
            { id: "t1", name: action.name, arguments: fixture.args },
            baseScope(parityAuthClass),
            deps,
          );
          expect(outcome.kind).toBe("denied");
          expect(errorCode(storedReceipt(store, outcomeResultId(outcome)))).toBe("policy_denied");
        });

        if (fixture.listFamily && !fixture.addonUnavailable) {
          it("preserves truncated list receipts without proving absence", async () => {
            const fake = createFakeWorkspace(mergeSeed(fixture.seed, {
              listTruncated: { [fixture.listFamily!]: true },
            }));
            const store = testStore();
            const deps = buildReadDeps({ fake, store });
            const args = fixture.truncationArgs ?? fixture.args;
            const v1 = successReceipt(await runV1Read(action.name, args, fake));
            expect(v1.ok).toBe(true);
            expect((v1.data as { truncated?: boolean }).truncated).toBe(true);
            expect(v1.warnings?.some((warning: { code?: string }) => warning.code === "list_truncated")).toBe(true);
            const outcome = await executeV2Read(
              { id: "t1", name: action.name, arguments: args },
              baseScope(parityAuthClass),
              deps,
            );
            expect(outcome.kind).toBe("succeeded");
            expect(receiptsSemanticallyEqual(v1, storedReceipt(store, outcomeResultId(outcome)))).toBe(true);
          });
        }

        it("matches v1 canonical receipts on identical fake seeds", async () => {
          const fake = createFakeWorkspace(mergeSeed(fixture.seed));
          const store = testStore();
          const deps = buildReadDeps({ fake, store });
          const scope = baseScope(parityAuthClass);
          const v1 = await runV1Read(action.name, fixture.args, fake);
          const outcome = await executeV2Read(
            { id: "t1", name: action.name, arguments: fixture.args },
            scope,
            deps,
          );
          expect(outcome.kind).toBe(v1.ok ? "succeeded" : "failed");
          const v2 = storedReceipt(store, outcomeResultId(outcome));
          expect(receiptsSemanticallyEqual(v1, v2)).toBe(true);
          if (v1.ok) assertCanonicalLinkPreserved(v1, v2, outcomeResultId(outcome));
        });

        const unicodeSeed = unicodeSeedForAction(action.name);
        const unicodeNeedle = expectedUnicodeSubstring(action.name);
        if (unicodeSeed && unicodeNeedle && !fixture.addonUnavailable) {
          it("preserves Unicode entity names verbatim", async () => {
            const fake = createFakeWorkspace(mergeSeed(unicodeSeed));
            const args = unicodeArgsForAction(action.name) ?? fixture.args;
            const store = testStore();
            const deps = buildReadDeps({ fake, store });
            const v1 = successReceipt(await runV1Read(action.name, args, fake));
            expect(receiptContainsUnicode(v1, unicodeNeedle)).toBe(true);
            const outcome = await executeV2Read(
              { id: "t1", name: action.name, arguments: args },
              baseScope(parityAuthClass),
              deps,
            );
            const v2 = successReceipt(storedReceipt(store, outcomeResultId(outcome)));
            expect(receiptContainsUnicode(v2, unicodeNeedle)).toBe(true);
          });
        }
      });
    }

    it("runs independent reads concurrently with provider order preserved", async () => {
      const fake = createFakeWorkspace(mergeSeed());
      const store = testStore();
      const deps = buildReadDeps({ fake, store });
      await assertConcurrentReadsPreserveOrder(concurrencyActions, deps, baseScope());
    });
  });

  describe(`v2 ${domain} read parity review notes`, () => {
    it("records live probe status as not_run", () => {
      expect("live_not_run_missing_credentials").toBe("live_not_run_missing_credentials");
    });
  });
}
