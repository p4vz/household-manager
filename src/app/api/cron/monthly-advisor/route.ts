import { NextResponse } from "next/server";
import { isValidCronRequest } from "@/core/net/cron";
import { noteCronCall } from "@/core/net/cron-seen";
import { runMonthlyAdvisorIfDue } from "@/modules/finance/api";

/** Called hourly by Railway cron; runs the AI card review once a month. */
export async function POST(req: Request) {
  if (!isValidCronRequest(req)) return new NextResponse(null, { status: 401 });
  await noteCronCall("monthly-advisor");
  try {
    return NextResponse.json(await runMonthlyAdvisorIfDue());
  } catch (err) {
    console.error(`[cron] monthly advisor failed: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ status: "error" }, { status: 502 });
  }
}
