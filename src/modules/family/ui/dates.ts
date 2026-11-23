import { householdTimeZone, zonedParts } from "@/core/time/zoned";

/** Today's date in household time (server side). */
export function householdToday(now = new Date()): string {
  return zonedParts(now, householdTimeZone()).date;
}

/** "Mon, Nov 23" for an ISO date. */
export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

/** "Monday, November 23" for an ISO date. */
export function longDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

/** "Today", "Tomorrow", "in 3 days", "2 days late". */
export function relativeDue(today: string, due: string): string {
  const d = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "1 day late";
  if (d < 0) return `${-d} days late`;
  return `in ${d} days`;
}
