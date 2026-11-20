import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Any Postgres driver (postgres-js in the app, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

const g = globalThis as unknown as { __hmDb?: Db };

export function db(): Db {
  if (!g.__hmDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const client = postgres(url, { max: 5, prepare: false });
    g.__hmDb = drizzle(client, { schema }) as PostgresJsDatabase<Schema> as unknown as Db;
  }
  return g.__hmDb;
}

/** Tests inject an in-memory database. */
export function setDbForTests(instance: Db): void {
  g.__hmDb = instance;
}
