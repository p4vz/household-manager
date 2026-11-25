import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/core/db/client";
import { IMAGE_TYPES, sniffImageType, type ImageType } from "@/core/files/sniff-image";
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
export const CARD_IMAGE_TYPES = IMAGE_TYPES;
export type CardImageType = ImageType;
export { sniffImageType };

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
