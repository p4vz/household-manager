import "server-only";
import { and, asc, eq, gte } from "drizzle-orm";
import { bus } from "@/core/bus";
import type { ModuleName } from "@/core/bus/events";
import { db } from "@/core/db/client";
import { calendarEvents } from "./schema";

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
