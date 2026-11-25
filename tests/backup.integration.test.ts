import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { setDbForTests, type Db } from "@/core/db/client";
import * as schema from "@/core/db/schema";
import { dumpDatabase } from "@/core/backup/dump";
import { backupFileName, decodeBackup, encodeBackup } from "@/core/backup/format";
import { backupDue, backupsToPrune } from "@/core/backup/retention";
// The restore script's own code (plain JS), so the two halves are tested together.
import { decodeBackup as decodeInScript, restoreBackup } from "../scripts/backup-format.mjs";

const key = randomBytes(32);
let source: PGlite;

async function snapshot(pg: PGlite) {
  const tables = (await pg.query<{ name: string }>(
    "select table_name::text as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
  )).rows;
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    const r = await pg.query<{ j: string }>(`select coalesce(json_agg(t order by t::text), '[]')::text as j from public."${name}" t`);
    out[name] = r.rows[0].j;
  }
  return out;
}

beforeAll(async () => {
  source = new PGlite();
  const d = drizzle(source, { schema });
  await migrate(d, { migrationsFolder: "./drizzle" });
  setDbForTests(d as unknown as Db);
  // A spread of types: jsonb, numeric with cents, timestamps, bytea, nulls, a foreign key, odd text.
  await source.exec(`
    insert into core_settings (key, value) values ('ai', '{"provider":"anthropic","n":12345678901234567890}'), ('quote''s', '"line\\nbreak"');
    insert into finance_accounts (id, bank_name, display_name, owner, kind, balance, balance_date)
      values ('11111111-1111-1111-1111-111111111111', 'Bank "A"', 'Everyday ✓', 'user2', 'credit', -1234.56, '2026-11-25T03:00:00Z');
    insert into finance_account_images (account_id, mime_type, cipher_text, iv, auth_tag, bytes, uploaded_by)
      values ('11111111-1111-1111-1111-111111111111', 'image/png', '\\x00ff10', '\\x0102', '\\xdead', 3, 'user2');
  `);
});

describe("backups", () => {
  it("encrypts and reads back in both the app and the restore script", async () => {
    const doc = await dumpDatabase(new Date("2026-11-25T08:00:00Z"));
    const file = encodeBackup(doc, key);
    expect(file.includes(Buffer.from("Everyday"))).toBe(false);
    expect(decodeBackup(file, key).tables.length).toBe(doc.tables.length);
    expect(decodeInScript(file, key)).toEqual(doc);
    expect(() => decodeBackup(file, randomBytes(32))).toThrow(/Wrong BACKUP_KEY/);
    const tampered = Buffer.from(file);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decodeInScript(tampered, key)).toThrow(/Wrong BACKUP_KEY/);
  });

  it("restores into an empty database with every row and value intact", async () => {
    const doc = await dumpDatabase();
    expect(doc.migrations.length).toBeGreaterThan(10);
    const target = new PGlite();
    const client = { query: async (text: string, params?: unknown[]) => (await target.query(text, params)).rows as Record<string, unknown>[] };
    const result = await restoreBackup(client, decodeInScript(encodeBackup(doc, key), key), { migrationsDir: "./drizzle" });
    expect(result.warnings).toEqual([]);
    expect(await snapshot(target)).toEqual(await snapshot(source));
    const migrations = await target.query("select hash, created_at::text as \"createdAt\" from drizzle.__drizzle_migrations order by id");
    expect(migrations.rows).toEqual(doc.migrations);
    // Drizzle sees nothing left to apply.
    await migrate(drizzle(target), { migrationsFolder: "./drizzle" });
    expect((await target.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows).toEqual([{ n: doc.migrations.length }]);
    // A second restore into the same (now full) database is refused.
    await expect(restoreBackup(client, doc, { migrationsDir: "./drizzle" })).rejects.toThrow(/not empty/);
  });

  it("keeps 30 days but never fewer than the newest 7", () => {
    const now = new Date("2026-12-31T08:00:00Z");
    const daysAgo = (n: number) => ({ id: String(n), createdTime: new Date(now.getTime() - n * 86_400_000).toISOString() });
    const daily = Array.from({ length: 40 }, (_, i) => daysAgo(i));
    expect(backupsToPrune(daily, now).map((f) => f.id)).toEqual(["31", "32", "33", "34", "35", "36", "37", "38", "39"]);
    const sparse = [daysAgo(50), daysAgo(60), daysAgo(70)];
    expect(backupsToPrune(sparse, now)).toEqual([]);
  });

  it("runs once a night in the 3 AM hour", () => {
    const now = new Date("2026-11-25T08:10:00Z");
    expect(backupDue({ localHour: 3, lastOkAt: null, now })).toBe(true);
    expect(backupDue({ localHour: 4, lastOkAt: null, now })).toBe(false);
    expect(backupDue({ localHour: 3, lastOkAt: "2026-11-25T08:00:00Z", now })).toBe(false);
    expect(backupDue({ localHour: 3, lastOkAt: "2026-11-24T08:00:00Z", now })).toBe(true);
    expect(backupFileName(now)).toBe("household-2026-11-25T0810Z.hmbackup");
  });
});
