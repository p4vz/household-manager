import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/core/db/client";
import { openBytes, sealBytes, vaultConfigured } from "@/core/secrets/file-vault";
import type { Viewer } from "../access";
import { financeAccountImages } from "../schema";

/**
 * Card pictures. The browser shrinks and re-encodes the photo (which drops
 * its metadata) before upload; here it is checked, encrypted with
 * DOC_VAULT_KEY and stored. Pictures are only ever decrypted to render the
 * Accounts page for a signed-in member. They are never sent to an AI
 * provider or an assistant, and nothing outside this file reads the table.
 */
export const MAX_CARD_IMAGE_BYTES = 600 * 1024;
export const CARD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type CardImageType = (typeof CARD_IMAGE_TYPES)[number];

/** The declared type must match the file's own signature. */
export function sniffImageType(bytes: Buffer): CardImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export { vaultConfigured as cardImagesConfigured };

export async function storeAccountImage(accountId: string, bytes: Buffer, uploadedBy: Viewer) {
  if (!vaultConfigured()) throw new Error("Set DOC_VAULT_KEY before adding card pictures.");
  if (bytes.length === 0) throw new Error("The picture is empty");
  if (bytes.length > MAX_CARD_IMAGE_BYTES) throw new Error("The picture is too large (600 KB at most)");
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new Error("Use a JPEG, PNG or WebP picture");
  const sealed = sealBytes(bytes);
  const row = { mimeType, ...sealed, bytes: bytes.length, uploadedBy, updatedAt: new Date() };
  await db()
    .insert(financeAccountImages)
    .values({ accountId, ...row })
    .onConflictDoUpdate({ target: financeAccountImages.accountId, set: row });
}

export async function removeAccountImage(accountId: string) {
  await db().delete(financeAccountImages).where(eq(financeAccountImages.accountId, accountId));
}

/** Pictures as data: URLs (the CSP allows data: images), by account id. */
export async function loadAccountImages(accountIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (accountIds.length === 0 || !vaultConfigured()) return out;
  const rows = await db().select().from(financeAccountImages).where(inArray(financeAccountImages.accountId, accountIds));
  for (const r of rows) {
    try {
      const plain = openBytes({ cipherText: r.cipherText, iv: r.iv, authTag: r.authTag });
      out.set(r.accountId, `data:${r.mimeType};base64,${plain.toString("base64")}`);
    } catch {
      // Wrong key or a damaged row: show no picture rather than fail the page.
    }
  }
  return out;
}
