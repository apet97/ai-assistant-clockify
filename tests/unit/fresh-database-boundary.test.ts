import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertFreshDatabaseBoundary,
  freshCutoverMarkerPath,
  writeFreshCutoverMarker,
} from "../../src/db/fresh-boundary.js";

/**
 * F24: a `new_unused` boundary claim is proven at boot. A nonempty database
 * with no fresh-cutover marker (the retained v1 production database) can
 * never boot under that claim; a path born fresh restarts normally.
 */
describe("fresh database boundary (F24)", () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fresh-boundary-"));
    databasePath = join(dir, "db.sqlite");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a missing or empty path is a first boot; the marker legitimizes restarts", () => {
    expect(assertFreshDatabaseBoundary(databasePath, "new_unused")).toEqual({ firstBoot: true });
    writeFileSync(databasePath, "");
    expect(assertFreshDatabaseBoundary(databasePath, "new_unused")).toEqual({ firstBoot: true });

    writeFileSync(databasePath, "sqlite data");
    writeFreshCutoverMarker(databasePath, { releaseSha: "a".repeat(40), createdAt: "2026-07-29T00:00:00.000Z" });
    expect(assertFreshDatabaseBoundary(databasePath, "new_unused")).toEqual({ firstBoot: false });
  });

  it("a nonempty unmarked database refuses to boot under new_unused", () => {
    writeFileSync(databasePath, "retained v1 data");
    expect(() => assertFreshDatabaseBoundary(databasePath, "new_unused"))
      .toThrow(/database_path_not_fresh/);
  });

  it("a corrupt marker proves nothing", () => {
    writeFileSync(databasePath, "data");
    writeFileSync(freshCutoverMarkerPath(databasePath), "{not json");
    expect(() => assertFreshDatabaseBoundary(databasePath, "new_unused"))
      .toThrow(/database_path_not_fresh/);
  });

  it("existing_expected, absent dispositions, and :memory: change nothing", () => {
    writeFileSync(databasePath, "existing data");
    expect(assertFreshDatabaseBoundary(databasePath, "existing_expected")).toEqual({ firstBoot: false });
    expect(assertFreshDatabaseBoundary(databasePath, undefined)).toEqual({ firstBoot: false });
    expect(assertFreshDatabaseBoundary(":memory:", "new_unused")).toEqual({ firstBoot: false });
  });
});
