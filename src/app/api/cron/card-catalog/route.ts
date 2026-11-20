import { NextResponse } from "next/server";
import { isValidCronRequest } from "@/core/net/cron";
import { runCatalogRefreshIfDue } from "@/modules/finance/api";

/**
 * Called hourly by Railway cron. Once a day (6 AM household time) checks
 * the card catalog entries that are due against their issuers' pages.
 */
export async function POST(req: Request) {
  if (!isValidCronRequest(req)) return new NextResponse(null, { status: 401 });
  try {
    return NextResponse.json(await runCatalogRefreshIfDue());
  } catch (err) {
    console.error(`[cron] card catalog refresh failed: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ status: "error" }, { status: 502 });
  }
}
