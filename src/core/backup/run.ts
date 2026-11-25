import "server-only";
import { getSetting, setSetting } from "@/core/settings/store";
import { householdTimeZone, zonedParts } from "@/core/time/zoned";
import { deleteBackup, DriveError, driveStatus, listBackups, openDrive, uploadBackup } from "./drive";
import { dumpDatabase } from "./dump";
import { backupFileName, backupKey, encodeBackup } from "./format";
import { backupDue, backupsToPrune } from "./retention";

const STATUS_KEY = "backup.status";

export type BackupStatus = {
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastMessage: string | null;
  lastOkAt: string | null;
  lastOkBytes: number | null;
  lastOkRows: number | null;
  kept: number | null;
};

const EMPTY: BackupStatus = { lastRunAt: null, lastOk: null, lastMessage: null, lastOkAt: null, lastOkBytes: null, lastOkRows: null, kept: null };

export async function backupStatus(): Promise<BackupStatus & { keySet: boolean; drive: Awaited<ReturnType<typeof driveStatus>> }> {
  const s = { ...EMPTY, ...((await getSetting(STATUS_KEY)) as Partial<BackupStatus> | undefined) };
  let keySet = true;
  try {
    backupKey();
  } catch {
    keySet = false;
  }
  return { ...s, keySet, drive: await driveStatus() };
}

let running = false;

/**
 * Dumps the database, encrypts it with BACKUP_KEY, uploads it to the
 * connected Drive folder and deletes copies past the retention window.
 * Nothing is written to local disk.
 */
export async function runBackup(now = new Date()): Promise<{ ok: boolean; message: string }> {
  if (running) return { ok: false, message: "A backup is already running" };
  running = true;
  const prev = { ...EMPTY, ...((await getSetting(STATUS_KEY)) as Partial<BackupStatus> | undefined) };
  try {
    const key = backupKey();
    const drive = await openDrive();
    const doc = await dumpDatabase(now);
    const bytes = encodeBackup(doc, key);
    const name = backupFileName(now);
    await uploadBackup(drive, name, bytes);
    const files = await listBackups(drive);
    const prune = backupsToPrune(files, now);
    for (const f of prune) await deleteBackup(drive, f.id);
    const rows = doc.tables.reduce((s, t) => s + t.count, 0);
    const message = `Saved ${name} (${(bytes.length / 1_048_576).toFixed(1)} MB, ${rows} rows)${prune.length ? `, removed ${prune.length} old` : ""}`;
    await setSetting(STATUS_KEY, {
      lastRunAt: now.toISOString(),
      lastOk: true,
      lastMessage: message,
      lastOkAt: now.toISOString(),
      lastOkBytes: bytes.length,
      lastOkRows: rows,
      kept: files.length - prune.length,
    } satisfies BackupStatus);
    return { ok: true, message };
  } catch (err) {
    // Fixed or Drive-written messages only; nothing that could carry a token.
    const message = err instanceof DriveError || (err instanceof Error && /BACKUP_KEY/.test(err.message)) ? err.message : "Backup failed (see server log)";
    console.error(`[backup] failed: ${err instanceof Error ? err.message : err}`);
    await setSetting(STATUS_KEY, { ...prev, lastRunAt: now.toISOString(), lastOk: false, lastMessage: message } satisfies BackupStatus);
    return { ok: false, message };
  } finally {
    running = false;
  }
}

/** Hourly cron entry: runs once a night in the 3 AM hour if Drive is connected. */
export async function runBackupIfDue(now = new Date()) {
  const s = await backupStatus();
  if (!s.drive.connected) return { status: "skipped" as const, reason: "Google Drive not connected" };
  if (!backupDue({ localHour: zonedParts(now, householdTimeZone()).hour, lastOkAt: s.lastOkAt, now })) {
    return { status: "skipped" as const, reason: "Not the backup slot" };
  }
  const r = await runBackup(now);
  return { status: r.ok ? ("ok" as const) : ("error" as const), message: r.message };
}
