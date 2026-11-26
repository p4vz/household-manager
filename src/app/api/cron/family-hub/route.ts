import { NextResponse } from "next/server";
import { isValidCronRequest } from "@/core/net/cron";
import { noteCronCall } from "@/core/net/cron-seen";
import { syncGoogleCalendarsIfStale } from "@/modules/calendar/api";
import { runHousekeeping, scanDueMailboxes } from "@/modules/family/api";

/**
 * Called hourly by Railway cron. Refreshes the kiosk's copy of the family
 * Google calendars (the kiosk page also refreshes it every 15 minutes while
 * it is on) and tidies bought shopping items and old returns. Chores need
 * no reset job: they reset at 4 AM by period. Connected Gmail mailboxes are
 * searched for return emails every 3 hours.
 */
export async function POST(req: Request) {
  if (!isValidCronRequest(req)) return new NextResponse(null, { status: 401 });
  await noteCronCall("family-hub");
  try {
    const [calendar, housekeeping, returnEmails] = await Promise.all([
      syncGoogleCalendarsIfStale(10 * 60_000),
      runHousekeeping(),
      scanDueMailboxes(),
    ]);
    return NextResponse.json({ calendar: { ok: calendar.ok, lastSyncAt: calendar.lastSyncAt }, housekeeping, returnEmails });
  } catch (err) {
    console.error(`[cron] family hub failed: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ status: "error" }, { status: 502 });
  }
}
