/**
 * Bank sync runs only at 7:00 and 19:00 household time. Railway cron calls
 * the endpoint hourly (cron is UTC and ignores DST); this decides whether
 * the current hour is a sync slot, so SimpleFIN is hit at most twice a day.
 */
export const SYNC_HOURS = [7, 19] as const;
/** Second line of defence against duplicate cron fires. */
export const MIN_SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** "Sync now" in Settings: SimpleFIN asks clients to stay well under 24 requests a day. */
export const MIN_MANUAL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
/** A run still marked "running" after this long is treated as dead. */
export const STALE_RUN_MS = 15 * 60 * 1000;

export function householdTimeZone(): string {
  return process.env.HOUSEHOLD_TIMEZONE || "America/New_York";
}

export function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now);
  return Number(h);
}

export function isSyncSlot(now: Date, timeZone = householdTimeZone()): boolean {
  return (SYNC_HOURS as readonly number[]).includes(localHour(now, timeZone));
}
