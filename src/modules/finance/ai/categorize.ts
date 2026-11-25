import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { categorizeTransactions } from "../categorize/run";
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

/**
 * Categorize what is uncategorized: from history first (amount, account,
 * description, memo, recurrence, past categories), then Claude for the
 * ambiguous rest, with that evidence attached. See categorize/engine.ts.
 */
export function categorizeUncategorized(opts: { ai?: boolean; now?: Date } = {}) {
  return categorizeTransactions({ ai: opts.ai ?? true, now: opts.now });
}

/** Manual correction: applies to every transaction from that merchant and future syncs. */
export async function setMerchantCategory(merchant: string, category: string, subcategory: string | null) {
  await db()
    .insert(financeCategoryRules)
    .values({ merchant: ruleKey(merchant), category, subcategory, source: "manual" })
    .onConflictDoUpdate({
      target: financeCategoryRules.merchant,
      set: { category, subcategory, source: "manual", updatedAt: new Date() },
    });
  await db()
    .update(t)
    .set({ category, subcategory, categorySource: "manual", categoryReason: null })
    .where(eq(t.merchant, merchant));
}
