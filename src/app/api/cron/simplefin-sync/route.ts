import { NextResponse } from "next/server";
import { isValidCronRequest } from "@/core/net/cron";
import { isSyncSlot, runScheduledSync } from "@/modules/finance/api";

/**
 * Called hourly by the Railway cron service. Only the 7 AM and 7 PM
 * household-time slots actually contact SimpleFIN.
 */
export async function POST(req: Request) {
  if (!isValidCronRequest(req)) return new NextResponse(null, { status: 401 });
  const now = new Date();
  if (!isSyncSlot(now)) return NextResponse.json({ status: "skipped", reason: "Not a sync slot" });
  const result = await runScheduledSync(now);
  return NextResponse.json(result, { status: result.status === "error" ? 502 : 200 });
}
