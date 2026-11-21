import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for the documents vault. The key lives only in DOC_VAULT_KEY,
 * separate from AUTH_SECRET, so rotating sign-in secrets never destroys
 * passport scans and a database dump alone exposes nothing. Losing the key
 * means losing the files.
 */
export function vaultConfigured(): boolean {
  return Boolean(process.env.DOC_VAULT_KEY);
}

function key(): Buffer {
  const raw = process.env.DOC_VAULT_KEY;
  if (!raw) throw new Error("DOC_VAULT_KEY is not set. Generate one with `openssl rand -base64 32`.");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`DOC_VAULT_KEY must decode to 32 bytes (got ${buf.length}).`);
  return buf;
}

export type Sealed = { cipherText: Buffer; iv: Buffer; authTag: Buffer };

export function sealBytes(plain: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const cipherText = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { cipherText, iv, authTag: cipher.getAuthTag() };
}

export function openBytes({ cipherText, iv, authTag }: Sealed): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  // A truncated tag would make forgery easier; GCM tags here are always 16 bytes.
  if (authTag.length !== 16) throw new Error("Invalid auth tag");
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]);
}
