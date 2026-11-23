import { boolean, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    allDay: boolean("all_day").notNull().default(true),
    notes: text("notes"),
    /** Which module created this event (null = entered by hand). */
    sourceModule: text("source_module"),
    /** Stable id in the source module, used to update/remove idempotently. */
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendar_events_source_uq").on(t.sourceModule, t.sourceRef)],
);

/**
 * Read-only copy of the family's Google Calendar events for the next week or
 * so, refreshed by `syncGoogleCalendars()`. `calendarKey` is the label from
 * GOOGLE_CALENDARS (e.g. "pavel"); the Google calendar id itself (often an
 * email address) stays in the environment and is never stored or sent to a
 * browser.
 */
export const calendarGoogleEvents = pgTable(
  "calendar_google_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    calendarKey: text("calendar_key").notNull(),
    googleEventId: text("google_event_id").notNull(),
    title: text("title").notNull(),
    location: text("location"),
    allDay: boolean("all_day").notNull().default(false),
    /** Timed events. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** All-day events (end exclusive, as Google sends it). */
    startDate: date("start_date"),
    endDate: date("end_date"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("calendar_google_events_uq").on(t.calendarKey, t.googleEventId),
    index("calendar_google_events_start_idx").on(t.startsAt),
  ],
);
