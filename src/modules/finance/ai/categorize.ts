import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { sanitizePayload } from "@/core/ai/sanitize";
import { db } from "@/core/db/client";
import { ruleKey } from "../ingest/categorize";
import { financeCategoryRules, financeTransactions as t } from "../schema";

export const DEFAULT_CATEGORIES = [
  "Auto & Transport",
  "Bills & Utilities",
  "Business",
  "Education",
  "Entertainment",
  "Fees & Charges",
  "Food & Dining",
  "Gifts & Donations",
  "Health & Fitness",
  "Home",
  "Income",
  "Kids",
  "Personal Care",
  "Pets",
  "Shopping",
  "Taxes",
  "Travel",
  "Transfer",
] as const;

const BATCH = 80;

/**
 * Batch-categorize merchants that have no rule yet, using the fast model.
 * The model sees only merchant names, a typical amount and how often they
 * appear: no dates, accounts or people.
 */
export function buildCategorizePayload(
  merchants: { merchant: string; typicalAmount: number; count: number }[],
  categories: string[],
) {
  // Merchants are referred to by index: scrubbing may alter the text.
  return sanitizePayload({ categories, merchants: merchants.map((m, id) => ({ id, ...m })) });
}

export async function categorizeUncategorized(): Promise<{ categorized: number; batches: number }> {
  const pending = await db()
    .select({
      merchant: t.merchant,
      typicalAmount: sql<number>`percentile_cont(0.5) within group (order by abs(${t.amount}))::float8`,
      count: sql<number>`count(*)::int`,
    })
    .from(t)
    .where(and(isNull(t.category), eq(t.isTransfer, false)))
    .groupBy(t.merchant)
    .orderBy(sql`count(*) desc`)
    .limit(BATCH * 5);
  if (pending.length === 0) return { categorized: 0, batches: 0 };

  const known = await db().selectDistinct({ category: financeCategoryRules.category }).from(financeCategoryRules);
  const categories = [...new Set([...known.map((k) => k.category), ...DEFAULT_CATEGORIES])].sort();
  const Result = z.object({
    assignments: z.array(
      z.object({
        id: z.number().int(),
        category: z.enum(categories as [string, ...string[]]),
        subcategory: z.string().nullable(),
      }),
    ),
  });

  let categorized = 0;
  let batches = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const { assignments } = await runStructured({
      tier: "fast",
      system:
        "You categorize household credit card and bank transactions. Pick exactly one category from the provided list for each merchant. Add a short subcategory only when obvious (e.g. Groceries, Restaurants, Gas). If unsure, use Shopping.",
      task: "Categorize every merchant in DATA.merchants. Return one assignment per merchant, identified by its id.",
      payload: buildCategorizePayload(batch, categories),
      schema: Result,
    });
    batches++;
    for (const a of assignments) {
      const merchant = batch[a.id]?.merchant;
      if (merchant === undefined) continue; // ignore anything the model invented
      await db()
        .insert(financeCategoryRules)
        .values({ merchant: ruleKey(merchant), category: a.category, subcategory: a.subcategory })
        .onConflictDoNothing();
      const updated = await db()
        .update(t)
        .set({ category: a.category, subcategory: a.subcategory })
        .where(and(eq(t.merchant, merchant), isNull(t.category)))
        .returning({ id: t.id });
      categorized += updated.length;
    }
  }
  return { categorized, batches };
}

/** Manual correction: applies to every transaction from that merchant and future syncs. */
export async function setMerchantCategory(merchant: string, category: string, subcategory: string | null) {
  await db()
    .insert(financeCategoryRules)
    .values({ merchant: ruleKey(merchant), category, subcategory })
    .onConflictDoUpdate({
      target: financeCategoryRules.merchant,
      set: { category, subcategory, updatedAt: new Date() },
    });
  await db().update(t).set({ category, subcategory }).where(eq(t.merchant, merchant));
}
