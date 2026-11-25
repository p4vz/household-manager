/** Pure retention rule for backups in Drive. */
export const KEEP_DAYS = 30;
export const KEEP_AT_LEAST = 7;

/**
 * Files to delete: older than `days`, but the newest `keepAtLeast` always
 * stay, so a month of failed runs never empties the folder.
 */
export function backupsToPrune<T extends { createdTime: string }>(files: T[], now: Date, days = KEEP_DAYS, keepAtLeast = KEEP_AT_LEAST): T[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return [...files]
    .sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime))
    .slice(keepAtLeast)
    .filter((f) => Date.parse(f.createdTime) < cutoff);
}

/** The nightly slot: once a day in the 3 AM hour (household time), unless today's copy already exists. */
export const BACKUP_HOUR = 3;
export function backupDue(input: { localHour: number; lastOkAt: string | null; now: Date }): boolean {
  if (input.localHour !== BACKUP_HOUR) return false;
  return !input.lastOkAt || input.now.getTime() - Date.parse(input.lastOkAt) > 20 * 3_600_000;
}
