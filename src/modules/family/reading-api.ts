import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { householdTimeZone } from "@/core/time/zoned";
import { bookShelves, shelveIfNew } from "./books-api";
import { assertNoCardNumber } from "./guard";
import { LANGUAGE_LABEL, MINUTES_TO_COUNT, READING_LANGUAGES, readingStats, type ReadingLanguage, type ReadingStats } from "./reading";
import { familyKids, familyReadingLog } from "./schema";
import { addDays, dayBucket } from "./time";

/**
 * Reading log: kids (on the kitchen screen), parents (phone) and Ask Claude
 * add entries; the rules live in reading.ts. Milestone stars are worked out
 * from the log, so deleting an entry takes its stars back.
 */
export class ReadingError extends Error {}

export const MAX_READING_MINUTES = 600;
export const MAX_READING_PAGES = 2000;
/** How far back a kid may date an entry on the kitchen screen (a forgotten weekend, not last month). */
export const READING_BACKDATE_DAYS = 14;
/** How far back a parent (phone, adult mode, Ask Claude in the app) may date one: copying an old paper log. */
export const PARENT_BACKDATE_DAYS = 366;

/** `backdateDays`: READING_BACKDATE_DAYS for kids, PARENT_BACKDATE_DAYS for parents. */
export type ReadingWriteOpts = { backdateDays?: number };

export type ReadingRow = {
  id: string;
  kidId: string;
  day: string;
  book: string;
  language: ReadingLanguage;
  minutes: number;
  pages: number | null;
  createdAt: Date;
};

export type ReadingInput = { kidId: string; day?: string; book: string; language: ReadingLanguage; minutes: number; pages?: number | null };

const tz = () => householdTimeZone();

function check(input: Omit<ReadingInput, "kidId">, now: Date, backdateDays = READING_BACKDATE_DAYS): { day: string; book: string; language: ReadingLanguage; minutes: number; pages: number | null } {
  const today = dayBucket(now, tz());
  const day = input.day ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ReadingError("Pick a date.");
  if (day > today) throw new ReadingError("That day hasn't happened yet.");
  if (day < addDays(today, -backdateDays)) {
    throw new ReadingError(backdateDays === READING_BACKDATE_DAYS ? `Only the last ${backdateDays} days can be logged here. A parent can add older days on the phone.` : `Only the last ${backdateDays} days can be logged.`);
  }
  const book = input.book.trim().slice(0, 80);
  if (!book) throw new ReadingError("Which book?");
  assertNoCardNumber(book);
  if (!READING_LANGUAGES.includes(input.language)) throw new ReadingError("English or Russian?");
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_READING_MINUTES) throw new ReadingError("How many minutes?");
  const pages = input.pages ?? null;
  if (pages !== null && (!Number.isInteger(pages) || pages < 0 || pages > MAX_READING_PAGES)) throw new ReadingError("Pages should be a number.");
  return { day, book, language: input.language, minutes: input.minutes, pages };
}

export async function addReading(input: ReadingInput, now = new Date(), opts: ReadingWriteOpts = {}): Promise<string> {
  const f = check(input, now, opts.backdateDays);
  const [kid] = await db().select({ id: familyKids.id }).from(familyKids).where(and(eq(familyKids.id, input.kidId), eq(familyKids.active, true)));
  if (!kid) throw new ReadingError("Kid not found.");
  const [row] = await db()
    .insert(familyReadingLog)
    .values({ kidId: input.kidId, ...f, createdAt: now })
    .returning({ id: familyReadingLog.id });
  await shelveIfNew(input.kidId, f.book, f.language);
  return row.id;
}

export async function getReading(id: string): Promise<ReadingRow | null> {
  const [row] = await db().select().from(familyReadingLog).where(eq(familyReadingLog.id, id));
  return row ? { ...row, language: row.language as ReadingLanguage } : null;
}

export async function updateReading(id: string, patch: Partial<Omit<ReadingInput, "kidId">>, now = new Date(), opts: ReadingWriteOpts = {}): Promise<void> {
  const current = await getReading(id);
  if (!current) throw new ReadingError("That entry is gone.");
  const f = check({ day: current.day, book: current.book, language: current.language, minutes: current.minutes, pages: current.pages, ...patch }, now, opts.backdateDays);
  await db().update(familyReadingLog).set(f).where(eq(familyReadingLog.id, id));
  if (patch.book) await shelveIfNew(current.kidId, f.book, f.language);
}

/**
 * Deletes an entry. `onlyToday` (the kitchen screen) refuses entries from
 * earlier days, so a sibling can't wipe someone's history.
 */
export async function deleteReading(id: string, opts: { onlyToday?: boolean; now?: Date } = {}): Promise<void> {
  if (opts.onlyToday) {
    const row = await getReading(id);
    if (!row) return;
    if (row.day !== dayBucket(opts.now ?? new Date(), tz())) throw new ReadingError("Only today's entries can be removed here. A parent can fix older ones on the phone.");
  }
  await db().delete(familyReadingLog).where(eq(familyReadingLog.id, id));
}

/** Restores a deleted entry (Ask Claude undo). */
export async function restoreReading(row: Omit<ReadingRow, "id" | "createdAt">): Promise<string> {
  const [r] = await db()
    .insert(familyReadingLog)
    .values({ kidId: row.kidId, day: row.day, book: row.book, language: row.language, minutes: row.minutes, pages: row.pages })
    .returning({ id: familyReadingLog.id });
  return r.id;
}

async function allEntries(kidId?: string) {
  const rows = await db()
    .select()
    .from(familyReadingLog)
    .where(kidId ? eq(familyReadingLog.kidId, kidId) : undefined)
    .orderBy(desc(familyReadingLog.day), desc(familyReadingLog.createdAt));
  return rows.map((r) => ({ ...r, language: r.language as ReadingLanguage }));
}

/** Milestone stars per kid, for the star bank. */
export async function readingStarsByKid(now = new Date()): Promise<Map<string, number>> {
  const today = dayBucket(now, tz());
  const byKid = new Map<string, ReadingRow[]>();
  for (const r of await allEntries()) byKid.set(r.kidId, [...(byKid.get(r.kidId) ?? []), r]);
  return new Map([...byKid.entries()].map(([k, es]) => [k, readingStats(es, today).stars]));
}

export type ReadingSummary = {
  stats: ReadingStats;
  /** Today's entries (the kiosk can remove these). */
  today: { id: string; book: string; language: ReadingLanguage; minutes: number; pages: number | null }[];
  /** Entries from the last 90 days, newest first (the reading history). */
  recent: { id: string; day: string; book: string; language: ReadingLanguage; minutes: number; pages: number | null }[];
  /** The kid's book shelf: books being read (last read first), then finished ones. */
  books: { id: string; title: string; author: string | null; language: ReadingLanguage; finished: boolean }[];
};

export async function readingSummaries(now = new Date()): Promise<Map<string, ReadingSummary>> {
  const today = dayBucket(now, tz());
  const kids = await db().select({ id: familyKids.id }).from(familyKids).where(eq(familyKids.active, true));
  const [rows, shelves] = await Promise.all([allEntries(), bookShelves()]);
  return new Map(
    kids.map((k) => {
      const mine = rows.filter((r) => r.kidId === k.id);
      // Entries are newest first, so the first entry for a title is when it was last read.
      const lastRead = new Map<string, string>();
      for (const r of mine) if (!lastRead.has(r.book.toLowerCase())) lastRead.set(r.book.toLowerCase(), r.day);
      const books = (shelves.get(k.id) ?? [])
        .map((b, i) => ({ b, i, last: lastRead.get(b.title.toLowerCase()) ?? "" }))
        .sort((x, y) => Number(x.b.finished) - Number(y.b.finished) || (x.last === y.last ? x.i - y.i : x.last < y.last ? 1 : -1))
        .map(({ b }) => ({ id: b.id, title: b.title, author: b.author, language: b.language, finished: b.finished }));
      const slim = (r: ReadingRow) => ({ id: r.id, book: r.book, language: r.language, minutes: r.minutes, pages: r.pages });
      return [
        k.id,
        {
          stats: readingStats(mine, today),
          today: mine.filter((r) => r.day === today).map(slim),
          recent: mine.filter((r) => r.day >= addDays(today, -90)).slice(0, 200).map((r) => ({ ...slim(r), day: r.day })),
          books,
        },
      ];
    }),
  );
}

/** Plain-language rule, for screens and Ask Claude. */
export const READING_RULE = `A day counts with ${MINUTES_TO_COUNT.en} minutes of ${LANGUAGE_LABEL.en} or ${MINUTES_TO_COUNT.ru} minutes of ${LANGUAGE_LABEL.ru} reading.`;

export async function readingLogSince(kidId: string, from: string) {
  return (await allEntries(kidId)).filter((r) => r.day >= from);
}

