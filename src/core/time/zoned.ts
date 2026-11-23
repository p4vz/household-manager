/**
 * Wall-clock helpers for the household time zone (HOUSEHOLD_TIMEZONE,
 * America/New_York by default). Pure and dependency-free.
 */
export type ZonedParts = { date: string; hour: number; minute: number; weekday: number };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall-clock date (YYYY-MM-DD), hour, minute and weekday (0 = Sunday) in `tz`. */
export function zonedParts(at: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

/** Adds whole days to an ISO date (no time zone involved). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The UTC instant of local midnight starting `isoDate` in `tz` (DST-safe). */
export function zonedMidnight(isoDate: string, tz: string): Date {
  const target = Date.parse(`${isoDate}T00:00:00Z`);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const wall = Date.parse(`${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00Z`);
    const diff = wall - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

export function householdTimeZone(): string {
  return process.env.HOUSEHOLD_TIMEZONE || "America/New_York";
}
