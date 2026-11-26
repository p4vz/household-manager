import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/core/db/client";
import { freshDb } from "./helpers/db";

/** Migration 0030 types in Danya's paper reading log; it must not duplicate days or touch other kids. */
let db: Db;
const migration = readFileSync("drizzle/0030_danya_reading_backfill.sql", "utf8").split("--> statement-breakpoint");
const run = async () => {
  for (const stmt of migration) await db.execute(sql.raw(stmt));
};
const rows = async (q: string) => (await db.execute(sql.raw(q))) as unknown as { rows: Record<string, unknown>[] };

beforeAll(async () => {
  db = await freshDb();
});

describe("Danya's reading backfill", () => {
  it("does nothing without a kid called Danya", async () => {
    await run();
    expect((await rows(`select count(*)::int as n from family_reading_log`)).rows[0].n).toBe(0);
  });

  it("adds the 17 days once, skipping days already logged, and shelves both books", async () => {
    await db.execute(sql`insert into family_kids (name) values ('Elana')`);
    const kid = (await rows(`insert into family_kids (name) values ('Danya') returning id`)).rows[0].id as string;
    await db.execute(sql`insert into family_reading_log (kid_id, day, book, language, minutes) values (${kid}, '2026-10-19', 'Something else', 'en', 30)`);
    await db.execute(sql`insert into family_books (kid_id, title, language) values (${kid}, 'tom sawyer', 'ru')`);
    await run();
    await run();
    const log = (await rows(`select day::text, book, minutes, pages from family_reading_log where kid_id = '${kid}' order by day`)).rows;
    expect(log).toHaveLength(17);
    expect(log.find((r) => r.day === "2026-10-19")?.book).toBe("Something else");
    expect(log.find((r) => r.day === "2026-10-25")).toMatchObject({ book: "Эмиль и Марго", minutes: 20, pages: 7 });
    expect(log.filter((r) => r.book === "Tom Sawyer").map((r) => r.day)).toEqual(["2026-11-22", "2026-11-24"]);
    expect(log.some((r) => r.day === "2026-10-22")).toBe(false);
    const books = (await rows(`select title from family_books where kid_id = '${kid}' order by title`)).rows.map((r) => r.title);
    expect(books).toEqual(["tom sawyer", "Эмиль и Марго"]);
    expect((await rows(`select count(*)::int as n from family_reading_log r join family_kids k on k.id = r.kid_id where k.name = 'Elana'`)).rows[0].n).toBe(0);
  });
});
