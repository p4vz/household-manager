import { NextResponse } from "next/server";
import { isValidCronRequest } from "@/core/net/cron";
import { noteCronCall } from "@/core/net/cron-seen";
import { runHouseAuditIfDue } from "@/assistant/house-audit";
import { isSyncSlot, runScheduledSync } from "@/modules/finance/api";

/**
 * Called hourly by the Railway cron service. Only the 7 AM and 7 PM
 * household-time slots actually contact SimpleFIN. After a sync, the weekly
 * house audit runs for each member whose last one is a week old.
 */
export async function POST(req: Request) {
  if (!isValidCronRequest(req)) return new NextResponse(null, { status: 401 });
  await noteCronCall("simplefin-sync");
  const now = new Date();
  if (!isSyncSlot(now)) return NextResponse.json({ status: "skipped", reason: "Not a sync slot" });
  const result = await runScheduledSync(now);
  const houseAudit = result.status === "error" ? [] : await runHouseAuditIfDue(now).catch(() => []);
  return NextResponse.json({ ...result, houseAudit }, { status: result.status === "error" ? 502 : 200 });
}
