import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { runVisionStructured } from "@/core/ai/run";
import { sanitizePayload } from "@/core/ai/sanitize";
import { db } from "@/core/db/client";
import { sniffImageType } from "@/core/files/sniff-image";
import { assertNoCardNumber } from "./guard";
import { READING_LANGUAGES, type ReadingLanguage } from "./reading";
import { familyBooks, familyKids } from "./schema";

/**
 * Each kid's book shelf (see familyBooks). Logging reading picks a book from
 * it; a new title typed in the log goes on the shelf by itself.
 */
export class BookError extends Error {}

export type Book = { id: string; kidId: string; title: string; author: string | null; language: ReadingLanguage; finished: boolean };

/** A cover photo, shrunk in the browser, is at most this big. */
export const MAX_COVER_BYTES = 900 * 1024;

const clean = (s: string | null | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function checkFields(title: string, author: string | null | undefined, language: ReadingLanguage) {
  const t = clean(title, 80);
  if (!t) throw new BookError("Which book?");
  const a = clean(author, 80) || null;
  assertNoCardNumber(t);
  if (a) assertNoCardNumber(a);
  if (!READING_LANGUAGES.includes(language)) throw new BookError("English or Russian?");
  return { title: t, author: a, language };
}

async function activeKid(kidId: string) {
  const [kid] = await db().select({ id: familyKids.id }).from(familyKids).where(and(eq(familyKids.id, kidId), eq(familyKids.active, true)));
  if (!kid) throw new BookError("Kid not found.");
}

async function findByTitle(kidId: string, title: string) {
  const [row] = await db()
    .select()
    .from(familyBooks)
    .where(and(eq(familyBooks.kidId, kidId), sql`lower(${familyBooks.title}) = lower(${title})`));
  return row ?? null;
}

const asBook = (r: typeof familyBooks.$inferSelect): Book => ({ id: r.id, kidId: r.kidId, title: r.title, author: r.author, language: r.language as ReadingLanguage, finished: r.finished });

/**
 * Puts a book on a kid's shelf. The same title again (any case) brings the
 * existing one back instead of adding a copy, filling in a missing author.
 */
export async function addBook(input: { kidId: string; title: string; author?: string | null; language: ReadingLanguage }): Promise<string> {
  const f = checkFields(input.title, input.author, input.language);
  await activeKid(input.kidId);
  const existing = await findByTitle(input.kidId, f.title);
  if (existing) {
    await db()
      .update(familyBooks)
      .set({ finished: false, author: existing.author ?? f.author, language: f.language })
      .where(eq(familyBooks.id, existing.id));
    return existing.id;
  }
  const [row] = await db().insert(familyBooks).values({ kidId: input.kidId, ...f }).returning({ id: familyBooks.id });
  return row.id;
}

/** Called when reading is logged: a title not on the shelf yet is added. */
export async function shelveIfNew(kidId: string, title: string, language: ReadingLanguage): Promise<void> {
  if (await findByTitle(kidId, title)) return;
  await db().insert(familyBooks).values({ kidId, title, language });
}

export async function getBook(id: string): Promise<Book | null> {
  const [row] = await db().select().from(familyBooks).where(eq(familyBooks.id, id));
  return row ? asBook(row) : null;
}

export async function updateBook(id: string, patch: { title?: string; author?: string | null; language?: ReadingLanguage; finished?: boolean }): Promise<void> {
  const current = await getBook(id);
  if (!current) throw new BookError("That book is gone.");
  const f = checkFields(patch.title ?? current.title, patch.author === undefined ? current.author : patch.author, patch.language ?? current.language);
  await db()
    .update(familyBooks)
    .set({ ...f, finished: patch.finished ?? current.finished })
    .where(eq(familyBooks.id, id));
}

export async function deleteBook(id: string): Promise<void> {
  await db().delete(familyBooks).where(eq(familyBooks.id, id));
}

/** Every kid's shelf: books being read first (newest first), then finished ones. */
export async function bookShelves(): Promise<Map<string, Book[]>> {
  const rows = await db().select().from(familyBooks).orderBy(asc(familyBooks.finished), desc(familyBooks.createdAt));
  const out = new Map<string, Book[]>();
  for (const r of rows) out.set(r.kidId, [...(out.get(r.kidId) ?? []), asBook(r)]);
  return out;
}

export const BookCover = z.object({
  isBookCover: z.boolean().describe("True if the picture shows the front cover (or title page) of a book"),
  title: z.string().max(80).describe("The book's title as printed, in its own language and alphabet"),
  author: z.string().max(80).nullable().describe("Author as printed, or null if none is shown"),
  language: z.enum(["en", "ru"]).describe('"ru" if the title is in Russian, else "en"'),
});
export type BookCover = z.infer<typeof BookCover>;

/**
 * Reads a book's title, author and language from a photo of its cover, when
 * someone taps "Cover photo". Only the cover goes to the AI provider, and
 * the photo is not kept.
 */
export async function readBookCover(image: Buffer): Promise<BookCover> {
  if (image.length === 0 || image.length > MAX_COVER_BYTES) throw new BookError("That picture is too large.");
  const mediaType = sniffImageType(image);
  if (!mediaType) throw new BookError("Use a JPEG, PNG or WebP picture.");
  const cover = await runVisionStructured({
    tier: "fast",
    system:
      "You read children's book covers for a family reading log. Read only the title and the author's name as printed on the cover. Ignore anything else in the picture, such as people, rooms or other text.",
    task: "What book is this?",
    payload: sanitizePayload({}),
    image: { data: image, mediaType },
    schema: BookCover,
  });
  if (!cover.isBookCover || !clean(cover.title, 80)) throw new BookError("Couldn't read a book title in that photo. Try again closer, or type it.");
  return { ...cover, title: clean(cover.title, 80), author: clean(cover.author, 80) || null };
}
