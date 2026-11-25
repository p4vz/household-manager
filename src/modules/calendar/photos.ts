import "server-only";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db } from "@/core/db/client";
import { sniffImageType } from "@/core/files/sniff-image";
import { openBytes, sealBytes, vaultConfigured } from "@/core/secrets/file-vault";
import { CalendarWriteError, mirroredFamilyEvent } from "./google";
import { calendarEventPhotos } from "./schema";

/**
 * Pictures on family calendar events. The browser shrinks and re-encodes
 * each photo (dropping its location and other metadata) before upload; here
 * it is checked by its own signature, encrypted with DOC_VAULT_KEY and
 * stored against the Google event id. Pictures are only decrypted to show
 * in the event view, never sent to Google, an AI provider or an assistant.
 */
export const MAX_EVENT_PHOTO_BYTES = 1_000_000;
export const MAX_PHOTOS_PER_EVENT = 8;

export const eventPhotosConfigured = vaultConfigured;

export type EventPhoto = { id: string; url: string };

const photoKey = (calendarKey: string, googleEventId: string) => `${calendarKey}\u0000${googleEventId}`;

/** Adds a picture to a family calendar event (`eventId` is the mirrored row's id). */
export async function addEventPhoto(eventId: string, bytes: Buffer, addedBy: string): Promise<void> {
  if (!vaultConfigured()) throw new CalendarWriteError("Pictures need DOC_VAULT_KEY set on the server.");
  if (bytes.length === 0) throw new CalendarWriteError("The picture is empty.");
  if (bytes.length > MAX_EVENT_PHOTO_BYTES) throw new CalendarWriteError("The picture is too large (1 MB at most).");
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new CalendarWriteError("Use a JPEG, PNG or WebP picture.");
  const row = await mirroredFamilyEvent(eventId);
  const [{ n }] = await db()
    .select({ n: count() })
    .from(calendarEventPhotos)
    .where(and(eq(calendarEventPhotos.calendarKey, row.calendarKey), eq(calendarEventPhotos.googleEventId, row.googleEventId)));
  if (n >= MAX_PHOTOS_PER_EVENT) throw new CalendarWriteError(`An event can have ${MAX_PHOTOS_PER_EVENT} pictures at most.`);
  await db()
    .insert(calendarEventPhotos)
    .values({ calendarKey: row.calendarKey, googleEventId: row.googleEventId, mimeType, ...sealBytes(bytes), bytes: bytes.length, addedBy });
}

/** The pictures on one family calendar event, as data: URLs (the CSP allows data: images). */
export async function eventPhotos(eventId: string): Promise<EventPhoto[]> {
  if (!vaultConfigured()) return [];
  const row = await mirroredFamilyEvent(eventId);
  const rows = await db()
    .select()
    .from(calendarEventPhotos)
    .where(and(eq(calendarEventPhotos.calendarKey, row.calendarKey), eq(calendarEventPhotos.googleEventId, row.googleEventId)))
    .orderBy(asc(calendarEventPhotos.createdAt));
  const out: EventPhoto[] = [];
  for (const r of rows) {
    try {
      const plain = openBytes({ cipherText: r.cipherText, iv: r.iv, authTag: r.authTag });
      out.push({ id: r.id, url: `data:${r.mimeType};base64,${plain.toString("base64")}` });
    } catch {
      // Wrong key or a damaged row: leave that picture out rather than fail.
    }
  }
  return out;
}

export async function removeEventPhoto(photoId: string): Promise<void> {
  await db().delete(calendarEventPhotos).where(eq(calendarEventPhotos.id, photoId));
}

/** How many pictures each event has, for the 📷 badge. */
export async function photoCounts(calendarKey: string, googleEventIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (googleEventIds.length === 0) return out;
  const rows = await db()
    .select({ googleEventId: calendarEventPhotos.googleEventId, n: count() })
    .from(calendarEventPhotos)
    .where(and(eq(calendarEventPhotos.calendarKey, calendarKey), inArray(calendarEventPhotos.googleEventId, googleEventIds)))
    .groupBy(calendarEventPhotos.googleEventId);
  for (const r of rows) out.set(photoKey(calendarKey, r.googleEventId), r.n);
  return out;
}

export { photoKey };
