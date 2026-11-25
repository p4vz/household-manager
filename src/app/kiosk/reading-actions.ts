"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { kioskAction } from "@/core/actions/kiosk-action";
import { isAdult } from "@/core/kiosk/permissions";
import {
  BookError,
  MAX_COVER_BYTES,
  PARENT_BACKDATE_DAYS,
  READING_BACKDATE_DAYS,
  READING_LANGUAGES,
  ReadingError,
  SensitiveTextError,
  addBook,
  addReading,
  deleteBook,
  deleteReading,
  readBookCover,
  updateBook,
} from "@/modules/family/api";

/**
 * Reading log from the kitchen screen and the phone (kioskAction: a paired
 * screen or a signed-in member). Anyone can log; on a locked kitchen screen
 * only today's entries can be taken back.
 */
const id = z.uuid();
type Result = { error: string | null };

function refresh() {
  revalidatePath("/kiosk");
  revalidatePath("/family");
}

async function attempt(fn: () => Promise<unknown>): Promise<Result> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ReadingError || err instanceof BookError || err instanceof SensitiveTextError) return { error: err.message };
    throw err;
  }
  refresh();
  return { error: null };
}

export const logReadingAction = kioskAction(
  "reading.log",
  z.object({
    kidId: id,
    day: z.iso.date().optional(),
    book: z.string().trim().min(1).max(80),
    language: z.enum(READING_LANGUAGES),
    minutes: z.number().int().min(1).max(600),
    pages: z.number().int().min(0).max(2000).nullable().optional(),
  }),
  // Kids date entries up to two weeks back; parents can copy an old paper log.
  async (input, actor) => attempt(() => addReading(input, new Date(), { backdateDays: isAdult(actor) ? PARENT_BACKDATE_DAYS : READING_BACKDATE_DAYS })),
);

export const deleteReadingAction = kioskAction("reading.log", z.object({ id }), async ({ id: entryId }, actor) =>
  attempt(() => deleteReading(entryId, { onlyToday: !isAdult(actor) })),
);

// ------------------------------------------------------------ book shelf ----

const bookFields = {
  title: z.string().trim().min(1).max(80),
  author: z.string().trim().max(80).nullable().optional(),
  language: z.enum(READING_LANGUAGES),
};

/** Anyone can put a book on a shelf or mark it finished; removing one needs an adult. */
export const addBookAction = kioskAction("reading.log", z.object({ kidId: id, ...bookFields }), async (input) => attempt(() => addBook(input)));

export const setBookFinishedAction = kioskAction("reading.log", z.object({ id, finished: z.boolean() }), async ({ id: bookId, finished }) =>
  attempt(() => updateBook(bookId, { finished })),
);

export const deleteBookAction = kioskAction("reading.log", z.object({ id }), async ({ id: bookId }, actor) => {
  if (!isAdult(actor)) return { error: "A parent can remove books. Tap ✓ when it's finished instead." };
  return attempt(() => deleteBook(bookId));
});

type CoverResult = { error: string | null; book?: { title: string; author: string | null; language: "en" | "ru" } };

/**
 * Reads title, author and language off a photo of a book cover (adult mode
 * on the kitchen screen, or the phone). The photo is shrunk in the browser,
 * sent to the AI provider once, and not stored.
 */
export const readBookCoverAction = kioskAction(
  "reading.cover",
  z.object({ image: z.string().max(Math.ceil((MAX_COVER_BYTES * 4) / 3) + 8) }),
  async ({ image }): Promise<CoverResult> => {
    try {
      const cover = await readBookCover(Buffer.from(image, "base64"));
      return { error: null, book: { title: cover.title, author: cover.author, language: cover.language } };
    } catch (err) {
      if (err instanceof BookError) return { error: err.message };
      console.error("book cover", err instanceof Error ? err.name : "error");
      return { error: "Couldn't read the cover right now. Type the title instead." };
    }
  },
);
