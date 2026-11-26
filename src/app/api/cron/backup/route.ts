import { NextResponse } from "next/server";
import { isValidCronRequest } from "@/core/net/cron";
import { noteCronCall } from "@/core/net/cron-seen";
import { runBackupIfDue } from "@/core/backup/run";

/**
 * Called hourly by Railway cron. Once a night (3 AM household time) writes
 * an encrypted copy of the database to the connected Google Drive folder
 * and deletes copies older than 30 days (always keeping the newest 7).
 */
export async function POST(req: Request) {
  if (!isValidCronRequest(req)) return new NextResponse(null, { status: 401 });
  await noteCronCall("backup");
  const result = await runBackupIfDue();
  return NextResponse.json(result, { status: result.status === "error" ? 502 : 200 });
}
