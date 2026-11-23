import { addDays, zonedParts } from "@/core/time/zoned";

/**
 * Household-time helpers for the family hub. Pure, so they are unit tested.
 *
 * Chores never need a job to "reset" them: a completion is stored against
 * the period it belongs to (`dateBucket`), and the board shows a chore as done
 * only if it has a completion in the current period. Periods roll over at
 * 4:00 AM household time (America/New_York by default):
 *
 * - daily chores: the bucket is the calendar date, shifted back 4 hours, so
 *   ticking "brush teeth" at 1 AM still counts for the evening before;
 * - weekly chores: the bucket is the Monday of that week, so the week rolls
 *   over late Sunday night (Monday 4:00 AM).
 */
export const RESET_HOUR = 4;

/** Today's date in household time (midnight rollover; for calendars and deadlines). */
export function householdToday(at: Date, tz: string): string {
  return zonedParts(at, tz).date;
}

/** The chore day `at` belongs to (4 AM rollover). */
export function dayBucket(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return p.hour < RESET_HOUR ? addDays(p.date, -1) : p.date;
}

/** Monday of the chore week `at` belongs to (rolls over Monday 4 AM). */
export function weekBucket(at: Date, tz: string): string {
  const day = dayBucket(at, tz);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

export type Recurrence = "daily" | "weekly" | "once";

export function bucketFor(recurrence: Recurrence, at: Date, tz: string): string {
  return recurrence === "weekly" ? weekBucket(at, tz) : dayBucket(at, tz);
}

/** Night mode window for the kiosk: 9:00 PM to 6:30 AM household time. */
export function isNightTime(at: Date, tz: string, start = { h: 21, m: 0 }, end = { h: 6, m: 30 }): boolean {
  const p = zonedParts(at, tz);
  const mins = p.hour * 60 + p.minute;
  const s = start.h * 60 + start.m;
  const e = end.h * 60 + end.m;
  return s > e ? mins >= s || mins < e : mins >= s && mins < e;
}

/** Days from `today` to `deadline` (negative when past). */
export function daysUntil(today: string, deadline: string): number {
  return Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export type Urgency = "overdue" | "urgent" | "soon" | "ok";

/** Return deadlines: red when past or within 2 days, amber within 7. */
export function deadlineUrgency(today: string, deadline: string | null): Urgency {
  if (!deadline) return "ok";
  const d = daysUntil(today, deadline);
  if (d < 0) return "overdue";
  if (d <= 2) return "urgent";
  if (d <= 7) return "soon";
  return "ok";
}

export { addDays, zonedParts };
