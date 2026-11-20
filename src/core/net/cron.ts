import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Scheduled jobs (SimpleFIN sync at 7 AM / 7 PM, monthly audits) are called
 * by Railway cron with `Authorization: Bearer $CRON_SECRET`. Constant-time
 * compare; a missing or short secret always fails.
 */
export function isValidCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 32) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
