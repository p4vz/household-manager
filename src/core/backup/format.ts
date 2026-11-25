import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The backup file format, shared with scripts/backup-format.mjs (the restore
 * script cannot import TypeScript; tests/backup.integration.test.ts checks
 * that the two read each other's files).
 *
 *   "HMBACKUP1" | 12-byte IV | 16-byte GCM tag | AES-256-GCM(gzip(JSON))
 *
 * The magic is authenticated as associated data. The key is BACKUP_KEY
 * (32 random bytes, base64), kept apart from AUTH_SECRET and DOC_VAULT_KEY
 * so a backup can be opened after the server's own secrets are gone, as long
 * as those two are saved too (the data inside is still sealed with them).
 */
export const BACKUP_MAGIC = Buffer.from("HMBACKUP1", "ascii");
export const BACKUP_EXTENSION = ".hmbackup";

export type BackupTable = { name: string; count: number; /** json_agg text, kept verbatim so numbers keep every digit. */ json: string };
export type BackupMigration = { hash: string; createdAt: string };
export type BackupDocument = {
  format: "household-manager-backup";
  version: 1;
  createdAt: string;
  migrations: BackupMigration[];
  tables: BackupTable[];
};

export function backupKey(raw = process.env.BACKUP_KEY): Buffer {
  if (!raw) throw new Error("BACKUP_KEY is not set. Generate one with `openssl rand -base64 32`.");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`BACKUP_KEY must decode to 32 bytes (got ${buf.length}).`);
  return buf;
}

export function encodeBackup(doc: BackupDocument, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(BACKUP_MAGIC);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(doc), "utf8"))), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decodeBackup(file: Buffer, key: Buffer): BackupDocument {
  if (file.length < BACKUP_MAGIC.length + 28 || !file.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error("Not a household-manager backup file");
  }
  const iv = file.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + 12);
  const tag = file.subarray(BACKUP_MAGIC.length + 12, BACKUP_MAGIC.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAAD(BACKUP_MAGIC);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(file.subarray(BACKUP_MAGIC.length + 28)), decipher.final()]);
  } catch {
    throw new Error("Wrong BACKUP_KEY, or the file is damaged");
  }
  const doc = JSON.parse(gunzipSync(plain).toString("utf8")) as BackupDocument;
  if (doc.format !== "household-manager-backup" || doc.version !== 1) throw new Error("Unsupported backup version");
  return doc;
}

/** Backup file name, sortable by time: household-2026-11-25T0300Z.hmbackup */
export function backupFileName(at: Date): string {
  return `household-${at.toISOString().slice(0, 16).replace(/:/g, "")}Z${BACKUP_EXTENSION}`;
}
