import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { financeCategoryRules } from "../schema";

export type CategoryRule = { category: string; subcategory: string | null };

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
    return { merchant, category: best.category, subcategory: best.subcategory, source: "learned" as const };
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
          source: sqlExcluded("source"),
          updatedAt: new Date(),
        },
        // A rule a person set outranks imported history.
        setWhere: sql`${financeCategoryRules.source} <> 'manual'`,
      });
  }
}

function sqlExcluded(col: string) {
  return sql.raw(`excluded.${col}`);
}
