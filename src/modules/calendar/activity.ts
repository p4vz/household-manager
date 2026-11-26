import "server-only";
import { and, asc, eq, gt, gte, isNull, or } from "drizzle-orm";
import { db } from "@/core/db/client";
import { FAMILY_KEY } from "./google-config";
import { calendarGoogleEvents } from "./schema";

export type CalendarChange = { id: string; title: string; startsAt: Date | null; startDate: string | null; allDay: boolean };

/**
 * Upcoming events on the family calendar that were added or changed in
 * Google after `since` (Google's own "updated" time, so events that only
 * slid into the synced window don't count as new). Holidays, school and
 * township calendars are left out.
 */
export async function calendarChangesSince(since: Date, now = new Date(), today: string): Promise<CalendarChange[]> {
  return db()
    .select({
      id: calendarGoogleEvents.id,
      title: calendarGoogleEvents.title,
      startsAt: calendarGoogleEvents.startsAt,
      startDate: calendarGoogleEvents.startDate,
      allDay: calendarGoogleEvents.allDay,
    })
    .from(calendarGoogleEvents)
    .where(
      and(
        eq(calendarGoogleEvents.calendarKey, FAMILY_KEY),
        gt(calendarGoogleEvents.googleUpdatedAt, since),
        or(gte(calendarGoogleEvents.startsAt, now), gte(calendarGoogleEvents.startDate, today), and(isNull(calendarGoogleEvents.startsAt), isNull(calendarGoogleEvents.startDate))),
      ),
    )
    .orderBy(asc(calendarGoogleEvents.startsAt), asc(calendarGoogleEvents.startDate))
    .limit(20);
}
