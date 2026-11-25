import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/core/db/client";
import type { BackupDocument, BackupMigration, BackupTable } from "./format";

type Row = Record<string, unknown>;
type Executor = { execute: (q: SQL) => Promise<unknown> };

/** postgres-js returns an array of rows, PGlite an object with `rows`. */
async function rows<T extends Row>(x: Executor, q: SQL): Promise<T[]> {
  const r = (await x.execute(q)) as T[] | { rows: T[] };
  return Array.isArray(r) ? r : r.rows;
}

const SAFE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Reads every table in the public schema, plus the list of applied
 * migrations, in one read-only repeatable-read transaction, so the copy is
 * consistent even while the app is writing. Each table travels as Postgres's
 * own JSON text (json_agg), which the restore feeds back through
 * json_populate_recordset: Postgres does both conversions, so dates, numbers,
 * jsonb and bytea come back exactly.
 */
export async function dumpDatabase(now = new Date()): Promise<BackupDocument> {
  return db().transaction(
    async (tx) => {
      const names = await rows<{ name: string }>(
        tx,
        sql`select table_name::text as name from information_schema.tables
            where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
      );
      const tables: BackupTable[] = [];
      for (const { name } of names) {
        if (!SAFE_NAME.test(name)) throw new Error(`Unexpected table name: ${name}`);
        const [r] = await rows<{ n: number | string; json: string }>(
          tx,
          sql.raw(`select count(*)::int as n, coalesce(json_agg(t), '[]'::json)::text as json from public."${name}" t`),
        );
        tables.push({ name, count: Number(r.n), json: r.json });
      }
      const [hasMigrations] = await rows<{ n: number | string }>(
        tx,
        sql`select count(*)::int as n from information_schema.tables where table_schema = 'drizzle' and table_name = '__drizzle_migrations'`,
      );
      const migrations: BackupMigration[] = Number(hasMigrations.n)
        ? await rows<BackupMigration>(tx, sql`select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations order by created_at, id`)
        : [];
      return { format: "household-manager-backup", version: 1, createdAt: now.toISOString(), migrations, tables };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
