// Restore or inspect a household-manager backup (see docs/BACKUP.md).
//
//   BACKUP_KEY=... node scripts/restore-backup.mjs inspect household-2026-11-25T0800Z.hmbackup
//   BACKUP_KEY=... node scripts/restore-backup.mjs restore household-2026-11-25T0800Z.hmbackup "postgresql://...new empty db..."
//
// Restore needs a NEW, EMPTY database. Run it from a checkout of the repo
// (same or newer than the backup); it applies the migrations up to the
// backup's level, loads the data, and leaves newer migrations to the app's
// start command (npm run db:migrate).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { backupKey, decodeBackup, restoreBackup } from "./backup-format.mjs";

const [cmd, file, url] = process.argv.slice(2);
if (!["inspect", "restore"].includes(cmd) || !file || (cmd === "restore" && !url)) {
  console.error("usage: node scripts/restore-backup.mjs inspect <file>\n       node scripts/restore-backup.mjs restore <file> <empty-database-url>");
  process.exit(2);
}

const doc = decodeBackup(readFileSync(file), backupKey(process.env.BACKUP_KEY));
const rows = doc.tables.reduce((s, t) => s + t.count, 0);
console.log(`Backup made ${doc.createdAt}: ${doc.tables.length} tables, ${rows} rows, ${doc.migrations.length} migrations.`);
if (cmd === "inspect") {
  for (const t of doc.tables) console.log(`  ${t.name.padEnd(40)} ${t.count}`);
  process.exit(0);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  const result = await restoreBackup(
    { query: (text, params) => sql.unsafe(text, params ?? []) },
    doc,
    { migrationsDir: join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle"), log: (m) => console.log(m) },
  );
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  console.log(`Restored ${result.rows} rows into ${result.tables} tables. Point the app's DATABASE_URL here and start it.`);
} finally {
  await sql.end();
}
