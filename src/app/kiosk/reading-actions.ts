"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { kioskAction } from "@/core/actions/kiosk-action";
import { isAdult } from "@/core/kiosk/permissions";
import { READING_LANGUAGES, ReadingError, SensitiveTextError, addReading, deleteReading } from "@/modules/family/api";

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
    if (err instanceof ReadingError || err instanceof SensitiveTextError) return { error: err.message };
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
  async (input) => attempt(() => addReading(input)),
);

export const deleteReadingAction = kioskAction("reading.log", z.object({ id }), async ({ id: entryId }, actor) =>
  attempt(() => deleteReading(entryId, { onlyToday: !isAdult(actor) })),
);
