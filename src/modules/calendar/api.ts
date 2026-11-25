import "server-only";
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { bus } from "@/core/bus";
import type { ModuleName } from "@/core/bus/events";
import { db } from "@/core/db/client";
import { addDays, householdTimeZone, zonedMidnight, zonedParts } from "@/core/time/zoned";
import { buildAgenda, type AgendaDay } from "./agenda";
import {
  calendarSources,
  CalendarWriteError,
  createGoogleEvent,
  deleteGoogleEvent,
  googleCalendarConfigured,
  googleSyncState,
  storedGoogleEvents,
  syncGoogleCalendars,
  updateGoogleEvent,
  type GoogleSyncState,
} from "./google";
import { calendarEvents } from "./schema";
import { FAMILY_KEY } from "./google-config";
import { photoCounts, photoKey } from "./photos";

export type { AgendaDay, AgendaItem, EditableEvent } from "./agenda";
export type { GoogleSyncState } from "./google";
export type { EventInput } from "./google-config";
export { KIOSK_DAYS_AHEAD, monthGridStart } from "./google-config";
export { addEventPhoto, eventPhotos, eventPhotosConfigured, removeEventPhoto, MAX_EVENT_PHOTO_BYTES, MAX_PHOTOS_PER_EVENT, type EventPhoto } from "./photos";
/**
 * Two-way family calendar: add, change or delete an event on the shared
 * Google calendar ("Pavel + Raisa"). Each call goes to Google first and then
 * updates the local mirror. Failures throw CalendarWriteError with a message
 * that is safe to show on screen.
 */
export { syncGoogleCalendars, createGoogleEvent, updateGoogleEvent, deleteGoogleEvent, CalendarWriteError };

/**
 * Calendar module public API. Other modules call these functions directly
 * (in-process, typed); they never touch calendar tables.
 */
export type CalendarEntry = {
  title: string;
  startDate: string;
  endDate?: string | null;
  notes?: string | null;
};

export type Source = { module: ModuleName; ref: string };

/** Create or update the event owned by `source`. Idempotent. */
export async function upsertEventFromSource(source: Source, entry: CalendarEntry) {
  const [row] = await db()
    .insert(calendarEvents)
    .values({
      ...entry,
      endDate: entry.endDate ?? null,
      notes: entry.notes ?? null,
      sourceModule: source.module,
      sourceRef: source.ref,
    })
    .onConflictDoUpdate({
      target: [calendarEvents.sourceModule, calendarEvents.sourceRef],
      set: {
        title: entry.title,
        startDate: entry.startDate,
        endDate: entry.endDate ?? null,
        notes: entry.notes ?? null,
      },
    })
    .returning({ id: calendarEvents.id });

  await bus.publish("calendar", "calendar.eventCreated", {
    eventId: row.id,
    title: entry.title,
    startDate: entry.startDate,
    sourceModule: source.module,
  });
  return row.id;
}

export async function removeEventFromSource(source: Source) {
  await db()
    .delete(calendarEvents)
    .where(
      and(eq(calendarEvents.sourceModule, source.module), eq(calendarEvents.sourceRef, source.ref)),
    );
}

export async function listUpcoming(fromDate: string, limit = 20) {
  return db()
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startDate: calendarEvents.startDate,
      endDate: calendarEvents.endDate,
      sourceModule: calendarEvents.sourceModule,
    })
    .from(calendarEvents)
    .where(gte(calendarEvents.startDate, fromDate))
    .orderBy(asc(calendarEvents.startDate))
    .limit(limit);
}

/** Module sources whose events the family wall screen may show (not finance reminders). */
const KIOSK_SOURCES = ["trips"];

export type KioskCalendar = {
  /** Today onwards. */
  days: AgendaDay[];
  /** Days from `opts.from` up to yesterday (for the month view); empty unless asked for. */
  earlier: AgendaDay[];
  legend: { label: string; color: string }[];
  configured: boolean;
  /** Label of the calendar new events go to, e.g. "Pavel + Raisa". */
  writableLabel: string | null;
  sync: GoogleSyncState;
};

/**
 * Day-by-day agenda for the kitchen kiosk: the family's Google calendars
 * plus household entries (trips, events typed by hand). Finance and upkeep
 * reminders are left out: the kiosk shows upkeep in its own panel and money
 * matters do not belong on a shared wall screen.
 */
export async function kioskCalendar(days: number, now = new Date(), opts: { from?: string } = {}): Promise<KioskCalendar> {
  const tz = householdTimeZone();
  const today = zonedParts(now, tz).date;
  const first = opts.from && opts.from < today ? opts.from : today;
  const earlierCount = Math.round((Date.parse(today) - Date.parse(first)) / 86_400_000);
  const last = addDays(today, days);
  const sources = calendarSources();
  const [google, household, sync] = await Promise.all([
    storedGoogleEvents(zonedMidnight(first, tz), zonedMidnight(last, tz), first, last),
    db()
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        sourceModule: calendarEvents.sourceModule,
      })
      .from(calendarEvents)
      .where(
        and(
          lte(calendarEvents.startDate, last),
          or(gte(calendarEvents.endDate, first), and(isNull(calendarEvents.endDate), gte(calendarEvents.startDate, first))),
        ),
      ),
    googleSyncState(),
  ]);
  const counts = await photoCounts(
    FAMILY_KEY,
    google.filter((g) => g.calendarKey === FAMILY_KEY).map((g) => g.googleEventId),
  );
  const googleRows = google.map((g) => ({ ...g, photoCount: counts.get(photoKey(g.calendarKey, g.googleEventId)) ?? 0 }));
  const shown = household.filter((e) => e.sourceModule === null || KIOSK_SOURCES.includes(e.sourceModule));
  return {
    days: buildAgenda({ today, days, tz, google: googleRows, household: shown, sources }),
    earlier: earlierCount > 0 ? buildAgenda({ today, start: first, days: earlierCount, tz, google: googleRows, household: shown, sources }) : [],
    legend: sources.map((s) => ({ label: s.label, color: s.color })),
    configured: googleCalendarConfigured(),
    writableLabel: googleCalendarConfigured() ? (sources.find((s) => s.writable)?.label ?? null) : null,
    sync,
  };
}

/** Refreshes Google events if the copy is older than `maxAgeMs` (kiosk page loads, cron). */
export async function syncGoogleCalendarsIfStale(maxAgeMs: number) {
  return syncGoogleCalendars({ maxAgeMs });
}
