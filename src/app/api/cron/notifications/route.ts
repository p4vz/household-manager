import { NextResponse } from "next/server";
import { isValidCronRequest } from "@/core/net/cron";
import { noteCronCall } from "@/core/net/cron-seen";
import { runNotifications } from "@/notify/run";

/**
 * Called hourly by Railway cron. Between 8 AM and 9 PM household time,
 * sends phone notifications for upkeep, registrations and inspections,
 * return deadlines and new things to review, each once per stage.
 */
export async function POST(req: Request) {
  if (!isValidCronRequest(req)) return new NextResponse(null, { status: 401 });
  await noteCronCall("notifications");
  try {
    return NextResponse.json(await runNotifications());
  } catch (err) {
    console.error(`[cron] notifications failed: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ status: "error" }, { status: 502 });
  }
}
