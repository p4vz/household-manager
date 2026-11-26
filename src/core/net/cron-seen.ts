import "server-only";
import { getSetting, setSetting } from "@/core/settings/store";

/**
 * Remembers when Railway cron last called each job, so setup checklists can
 * tell whether a job is in the cron start command. Only the time is kept.
 */
export async function noteCronCall(job: string, now = new Date()): Promise<void> {
  try {
    await setSetting(`cron.seen.${job}`, now.toISOString());
  } catch (err) {
    console.error(`[cron] could not note ${job}: ${err instanceof Error ? err.message : err}`);
  }
}

export async function lastCronCall(job: string): Promise<Date | null> {
  const v = await getSetting(`cron.seen.${job}`);
  return typeof v === "string" ? new Date(v) : null;
}
