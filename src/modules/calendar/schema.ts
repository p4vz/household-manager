import { boolean, date, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
