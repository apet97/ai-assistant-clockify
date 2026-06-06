import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Installation-token encryption at rest (DATA_MODEL "Encryption").
 *
 * Stored value format: `v1:<base64url nonce>:<base64url ciphertext>:<base64url authTag>`
 * Algorithm: AES-256-GCM. The 32-byte key is derived from the configured
 * DATA_ENCRYPTION_KEY via SHA-256 so any non-empty secret string is accepted.
 */

const VERSION = "v1";

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(":");
}

export function decryptSecret(value: string, secret: string): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("unsupported ciphertext format");
  }
  const [, nonceB64, ciphertextB64, authTagB64] = parts;
  const key = deriveKey(secret);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceB64, "base64url"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64url")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
