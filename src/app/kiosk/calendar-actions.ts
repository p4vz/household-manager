"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { kioskAction } from "@/core/actions/kiosk-action";
import { CalendarWriteError, createGoogleEvent, deleteGoogleEvent, updateGoogleEvent } from "@/modules/calendar/api";

/**
 * Family calendar actions for the kitchen screen and the phone view: add,
 * change and delete events on the shared Google calendar. Kept apart from
 * ./actions.ts because deleting is otherwise member-only; the one delete
 * allowed here is a family calendar event (the spec asks for it on the
 * wall screen, and Google keeps deleted events in its bin for 30 days).
 * tests/boundaries.test.ts checks that nothing else is deleted from here.
 */
const id = z.uuid();

function refresh() {
  revalidatePath("/kiosk");
  revalidatePath("/family");
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const eventInput = z.object({
  title: z.string().trim().min(1).max(120),
  location: z.string().trim().max(120).nullish(),
  allDay: z.boolean(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  startTime: hhmm.nullish(),
  endTime: hhmm.nullish(),
});

type Result = { error: string | null };

/** Google failures come back as a message for the modal, not a thrown error (which production hides). */
async function calendarWrite(fn: () => Promise<void>): Promise<Result> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof CalendarWriteError) {
      refresh();
      return { error: err.message };
    }
    throw err;
  }
  refresh();
  return { error: null };
}

export const createEventAction = kioskAction(eventInput, async (input) => calendarWrite(() => createGoogleEvent(input)));

export const updateEventAction = kioskAction(eventInput.extend({ id }), async ({ id: eventId, ...input }) =>
  calendarWrite(() => updateGoogleEvent(eventId, input)),
);

export const deleteEventAction = kioskAction(z.object({ id }), async ({ id: eventId }) => calendarWrite(() => deleteGoogleEvent(eventId)));
