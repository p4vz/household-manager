import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { setDbForTests, type Db } from "@/core/db/client";
import * as schema from "@/core/db/schema";

/** Fresh in-memory Postgres with the real migrations applied. */
export async function freshDb(): Promise<Db> {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  const db = pg as unknown as Db;
  setDbForTests(db);
  return db;
}
