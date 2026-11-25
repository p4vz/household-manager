import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

/**
 * Migration 0011/0012 moves existing shopping items (one flat list by store,
 * some marked "staple") into a "Shopping" list with a section per store, and
 * turns the staples into a "Staples" template.
 */
const journal = JSON.parse(readFileSync(join(__dirname, "../drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };

async function apply(pg: PGlite, from: number, to: number) {
  for (const e of journal.entries.filter((x) => x.idx >= from && x.idx <= to)) {
    const sql = readFileSync(join(__dirname, `../drizzle/${e.tag}.sql`), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
}

describe("shopping migration", () => {
  it("keeps existing items and turns staples into a template", async () => {
    const pg = new PGlite();
    await apply(pg, 0, 10);
    await pg.exec(`
      INSERT INTO family_shopping_items (name, store, is_staple, checked, created_at) VALUES
        ('Milk', 'Costco', true, false, '2026-11-01T10:00:00Z'),
        ('Cake', 'Costco', false, true, '2026-11-02T10:00:00Z'),
        ('Eggs', 'Giant', true, false, '2026-11-03T10:00:00Z');
    `);
    await apply(pg, 11, 12);

    const lists = await pg.query<{ name: string }>(`SELECT name FROM family_shopping_lists`);
    expect(lists.rows.map((r) => r.name)).toEqual(["Shopping"]);
    const items = await pg.query<{ store: string; name: string; checked: boolean; sort_order: number }>(`
      SELECT s.store, i.name, i.checked, i.sort_order FROM family_shopping_items i
      JOIN family_shopping_sections s ON s.id = i.section_id ORDER BY s.sort_order, i.sort_order`);
    expect(items.rows).toEqual([
      { store: "Costco", name: "Milk", checked: false, sort_order: 0 },
      { store: "Costco", name: "Cake", checked: true, sort_order: 1 },
      { store: "Giant", name: "Eggs", checked: false, sort_order: 0 },
    ]);
    const tpl = await pg.query<{ template: string; store: string; name: string }>(`
      SELECT t.name AS template, i.store, i.name FROM family_shopping_template_items i
      JOIN family_shopping_templates t ON t.id = i.template_id ORDER BY t.created_at, i.store_order, i.sort_order`);
    expect(tpl.rows.filter((r) => r.template === "Staples").map((r) => `${r.store}:${r.name}`)).toEqual(["Costco:Milk", "Giant:Eggs"]);
    expect(tpl.rows.filter((r) => r.template === "Weekly Sam's").map((r) => r.name)).toEqual(["Milk", "Eggs", "Yogurt", "Berries", "Fruits"]);
    expect(tpl.rows.filter((r) => r.template === "Weekly Russian").map((r) => `${r.store}:${r.name}`)).toEqual(["Russian store:Tvorog", "Russian store:Snacks", "Russian store:Eggs"]);
  });

  it("creates nothing but the starter templates on an empty database", async () => {
    const pg = new PGlite();
    await apply(pg, 0, 12);
    expect((await pg.query(`SELECT 1 FROM family_shopping_lists`)).rows).toHaveLength(0);
    expect((await pg.query<{ name: string }>(`SELECT name FROM family_shopping_templates ORDER BY created_at`)).rows.map((r) => r.name)).toEqual(["Weekly Sam's", "Weekly Russian"]);
  });
});
