"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { kioskAction } from "@/core/actions/kiosk-action";
import {
  CalendarWriteError,
  MAX_EVENT_PHOTO_BYTES,
  addEventPhoto,
  createGoogleEvent,
  eventPhotos,
  updateGoogleEvent,
  type EventPhoto,
} from "@/modules/calendar/api";

/**
 * Family calendar actions for the kitchen screen and the phone view: add
 * and change events on the shared Google calendar, see their pictures and
 * add a picture. Kids use the kitchen
 * screen, so taking an event off the calendar is member-only
 * (app/(app)/family/actions.ts); tests/boundaries.test.ts checks that
 * nothing here can do it.
 */
const id = z.uuid();

function refresh() {
  revalidatePath("/kiosk");
  revalidatePath("/family");
  revalidatePath("/calendar");
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const eventInput = z.object({
  title: z.string().trim().min(1).max(120),
  location: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  allDay: z.boolean(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  startTime: hhmm.nullish(),
  endTime: hhmm.nullish(),
});

type Result = { error: string | null };

/** Google failures come back as a message for the modal, not a thrown error (which production hides). */
async function calendarWrite(fn: () => Promise<unknown>): Promise<Result> {
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

export const createEventAction = kioskAction("calendar.add", eventInput, async (input) => calendarWrite(() => createGoogleEvent(input)));

export const updateEventAction = kioskAction("calendar.edit", eventInput.extend({ id }), async ({ id: eventId, ...input }) =>
  calendarWrite(() => updateGoogleEvent(eventId, input)),
);

/** The pictures on one family calendar event (loaded when the event is opened). */
export const eventPhotosAction = kioskAction("hub.view", z.object({ id }), async ({ id: eventId }): Promise<{ photos: EventPhoto[]; error: string | null }> => {
  try {
    return { photos: await eventPhotos(eventId), error: null };
  } catch (err) {
    if (err instanceof CalendarWriteError) return { photos: [], error: err.message };
    throw err;
  }
});

const photoInput = z.object({
  id,
  file: z.instanceof(Blob).refine((f) => f.size > 0 && f.size <= MAX_EVENT_PHOTO_BYTES, "The picture is too large (1 MB at most)."),
});

/** Adds a picture (already shrunk and re-encoded in the browser) to a family calendar event. */
export const addEventPhotoAction = kioskAction("calendar.photo.add", photoInput, async ({ id: eventId, file }, actor) =>
  calendarWrite(async () => addEventPhoto(eventId, Buffer.from(await file.arrayBuffer()), actor.kind === "member" ? actor.user.owner : "Kiosk")),
);
