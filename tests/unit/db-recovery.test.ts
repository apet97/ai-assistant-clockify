import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupDatabase, restoreDatabase } from "../../src/db/recovery.js";
import { encryptSecret } from "../../src/db/encryption.js";
import { createStore, type TestStore } from "../../src/db/store.js";

const ENCRYPTION_KEY = "recovery-test-encryption-key";
const tempDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ai-assistant-recovery-"));
  tempDirectories.push(directory);
  return directory;
}

function seedEncryptedDatabase(path: string, token = "secret-addon-token"): void {
  const store = createStore(path, { encryptionKey: ENCRYPTION_KEY });
  store.saveInstallation({
    workspaceId: "workspace-recovery",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: token,
  });
  store.close();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database backup and restore", () => {
  it("reopens and integrity-checks the completed backup before writing either sidecar", async () => {
    const directory = tempDirectory();
    const source = join(directory, "source.sqlite");
    const backup = join(directory, "backup.sqlite");
    seedEncryptedDatabase(source);

    let integrityChecks = 0;
    vi.spyOn(Database.prototype, "pragma").mockImplementation((statement) => {
      expect(statement).toBe("integrity_check");
      integrityChecks += 1;
      return integrityChecks === 1 ? "ok" : "forced completed-backup failure";
    });

    await expect(backupDatabase({ sourcePath: source, destinationPath: backup }))
      .rejects.toThrow("Completed backup integrity check failed");

    expect(integrityChecks).toBe(2);
    expect(existsSync(backup)).toBe(true);
    expect(existsSync(`${backup}.sha256`)).toBe(false);
    expect(existsSync(`${backup}.json`)).toBe(false);
  });

  it("removes prior evidence sidecars before a replacement backup can fail", async () => {
    const directory = tempDirectory();
    const source = join(directory, "source.sqlite");
    const backup = join(directory, "backup.sqlite");
    seedEncryptedDatabase(source);
    await backupDatabase({ sourcePath: source, destinationPath: backup });
    expect(existsSync(`${backup}.sha256`)).toBe(true);
    expect(existsSync(`${backup}.json`)).toBe(true);

    let integrityChecks = 0;
    vi.spyOn(Database.prototype, "pragma").mockImplementation((statement) => {
      expect(statement).toBe("integrity_check");
      integrityChecks += 1;
      return integrityChecks === 1 ? "ok" : "forced replacement-backup failure";
    });

    await expect(backupDatabase({ sourcePath: source, destinationPath: backup }))
      .rejects.toThrow("Completed backup integrity check failed");

    expect(existsSync(`${backup}.sha256`)).toBe(false);
    expect(existsSync(`${backup}.json`)).toBe(false);
  });

  it("backs up and restores encrypted installation tokens through importable functions", async () => {
    const directory = tempDirectory();
    const source = join(directory, "source.sqlite");
    const backup = join(directory, "backups", "backup.sqlite");
    const restored = join(directory, "restored.sqlite");
    seedEncryptedDatabase(source);

    const createdAt = new Date("2026-07-14T12:00:00.000Z");
    const backupResult = await backupDatabase({
      sourcePath: source,
      destinationPath: backup,
      now: () => createdAt,
    });

    expect(backupResult).toMatchObject({
      destinationPath: backup,
      checksumPath: `${backup}.sha256`,
      metadataPath: `${backup}.json`,
      sha256: sha256(backup),
    });
    expect(readFileSync(`${backup}.sha256`, "utf8")).toBe(
      `${backupResult.sha256}  ${basename(backup)}\n`,
    );
    expect(JSON.parse(readFileSync(`${backup}.json`, "utf8"))).toEqual({
      format: 1,
      createdAt: createdAt.toISOString(),
      source,
      bytes: readFileSync(backup).byteLength,
      sha256: backupResult.sha256,
    });

    await restoreDatabase({ backupPath: backup, targetPath: restored });

    const store = createStore(restored, { encryptionKey: ENCRYPTION_KEY }) as TestStore;
    expect(store.getInstallation("workspace-recovery")?.addonToken).toBe("secret-addon-token");
    expect(store.rawAddonTokenForTest("workspace-recovery")).not.toContain("secret-addon-token");
    store.close();
  });

  it("rejects a checksum mismatch without creating the restore target", async () => {
    const directory = tempDirectory();
    const source = join(directory, "source.sqlite");
    const backup = join(directory, "backup.sqlite");
    const target = join(directory, "target.sqlite");
    seedEncryptedDatabase(source);
    await backupDatabase({ sourcePath: source, destinationPath: backup });
    appendFileSync(backup, "tampered-after-checksum");

    await expect(restoreDatabase({ backupPath: backup, targetPath: target }))
      .rejects.toThrow("Checksum mismatch");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a corrupt backup even when its checksum sidecar matches", async () => {
    const directory = tempDirectory();
    const backup = join(directory, "corrupt.sqlite");
    const target = join(directory, "target.sqlite");
    writeFileSync(backup, "not a sqlite database");
    writeFileSync(`${backup}.sha256`, `${sha256(backup)}  corrupt.sqlite\n`);

    await expect(restoreDatabase({ backupPath: backup, targetPath: target }))
      .rejects.toThrow("Backup integrity check failed");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses to overwrite an existing target and leaves it byte-identical", async () => {
    const directory = tempDirectory();
    const source = join(directory, "source.sqlite");
    const backup = join(directory, "backup.sqlite");
    const target = join(directory, "target.sqlite");
    seedEncryptedDatabase(source);
    await backupDatabase({ sourcePath: source, destinationPath: backup });
    const sentinel = Buffer.from("preserve-current-database", "utf8");
    writeFileSync(target, sentinel);

    await expect(restoreDatabase({ backupPath: backup, targetPath: target }))
      .rejects.toThrow("Target exists");
    expect(readFileSync(target)).toEqual(sentinel);
    expect(readdirSync(directory).some((entry) => entry.endsWith(".restore"))).toBe(false);
  });

  it("does not clobber a target created after the existence check but before final install", async () => {
    const directory = tempDirectory();
    const source = join(directory, "source.sqlite");
    const backup = join(directory, "backup.sqlite");
    const target = join(directory, "target.sqlite");
    seedEncryptedDatabase(source);
    await backupDatabase({ sourcePath: source, destinationPath: backup });
    const sentinel = Buffer.from("created-by-another-process-during-restore", "utf8");

    await expect(restoreDatabase({
      backupPath: backup,
      targetPath: target,
      beforeInstall: (temporaryPath) => {
        expect(existsSync(temporaryPath)).toBe(true);
        writeFileSync(target, sentinel, { flag: "wx" });
      },
    })).rejects.toThrow("Target exists");

    expect(readFileSync(target)).toEqual(sentinel);
    expect(readdirSync(directory).some((entry) => entry.endsWith(".restore"))).toBe(false);
  });

  it("rolls back every token update when a restored database contains mixed unknown keys", async () => {
    const directory = tempDirectory();
    const source = join(directory, "source.sqlite");
    const backup = join(directory, "backup.sqlite");
    const restored = join(directory, "restored.sqlite");
    const oldKey = "old-recovery-encryption-key";
    const newKey = "new-recovery-encryption-key";
    const unrelatedKey = "unrelated-recovery-key";
    const seed = createStore(source, { encryptionKey: oldKey });
    for (const workspaceId of ["workspace-first", "workspace-unknown"]) {
      seed.saveInstallation({
        workspaceId,
        addonId: "addon-1",
        addonUserId: "addon-user-1",
        addonToken: `token-${workspaceId}`,
      });
    }
    seed.close();

    const raw = new Database(source);
    raw.prepare("UPDATE installations SET addon_token_ciphertext = ? WHERE workspace_id = ?")
      .run(encryptSecret("token-workspace-unknown", unrelatedKey), "workspace-unknown");
    raw.close();
    await backupDatabase({ sourcePath: source, destinationPath: backup });
    await restoreDatabase({ backupPath: backup, targetPath: restored });

    const before = new Database(restored, { readonly: true });
    const originalCiphertext = (before.prepare(
      "SELECT addon_token_ciphertext FROM installations WHERE workspace_id = ?",
    ).get("workspace-first") as { addon_token_ciphertext: string }).addon_token_ciphertext;
    before.close();

    expect(() => createStore(restored, {
      encryptionKey: newKey,
      previousEncryptionKey: oldKey,
    })).toThrow();

    const after = new Database(restored, { readonly: true });
    const rolledBackCiphertext = (after.prepare(
      "SELECT addon_token_ciphertext FROM installations WHERE workspace_id = ?",
    ).get("workspace-first") as { addon_token_ciphertext: string }).addon_token_ciphertext;
    after.close();
    expect(rolledBackCiphertext).toBe(originalCiphertext);
  });
});
