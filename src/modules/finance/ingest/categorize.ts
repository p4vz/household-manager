import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { financeCategoryRules } from "../schema";

export type CategoryRule = { category: string; subcategory: string | null };

export async function loadRules(merchants: string[]): Promise<Map<string, CategoryRule>> {
  const unique = [...new Set(merchants.map(ruleKey))];
  if (unique.length === 0) return new Map();
  const rows = await db().select().from(financeCategoryRules).where(inArray(financeCategoryRules.merchant, unique));
  return new Map(rows.map((r) => [r.merchant, { category: r.category, subcategory: r.subcategory }]));
}

export function ruleKey(merchant: string): string {
  return merchant.trim().toLowerCase();
}

/** Learn the most common category per merchant from categorized rows. */
export async function learnRules(rows: { merchant: string; category: string | null; subcategory: string | null }[]) {
  const counts = new Map<string, Map<string, { n: number; rule: CategoryRule }>>();
  for (const r of rows) {
    if (!r.category) continue;
    const key = ruleKey(r.merchant);
    const id = `${r.category}\u0000${r.subcategory ?? ""}`;
    const byCat = counts.get(key) ?? new Map();
    const entry = byCat.get(id) ?? { n: 0, rule: { category: r.category, subcategory: r.subcategory } };
    entry.n++;
    byCat.set(id, entry);
    counts.set(key, byCat);
  }
  const values = [...counts.entries()].map(([merchant, byCat]) => {
    const best = [...byCat.values()].sort((a, b) => b.n - a.n)[0].rule;
    return { merchant, category: best.category, subcategory: best.subcategory };
  });
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500);
    await db()
      .insert(financeCategoryRules)
      .values(chunk)
      .onConflictDoUpdate({
        target: financeCategoryRules.merchant,
        set: {
          category: sqlExcluded("category"),
          subcategory: sqlExcluded("subcategory"),
          updatedAt: new Date(),
        },
      });
  }
}

function sqlExcluded(col: string) {
  return sql.raw(`excluded.${col}`);
}
