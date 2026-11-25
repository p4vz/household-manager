import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { financeAccounts, financeTransactions as t } from "../schema";
import { visibleTo, type Viewer } from "../access";
import type { CategoryFact, MerchantFact, OwnerKey } from "./compute";

/** Income = an "Income…" category, or an uncategorized deposit. */
export const isIncome = sql`(${t.category} ilike 'income%' or (${t.category} is null and ${t.amount} > 0))`;
const month = sql<string>`to_char(${t.postedDate}, 'YYYY-MM')`;
const spend = sql<number>`coalesce(sum(case when ${isIncome} then 0 else -${t.amount} end), 0)::float8`;
const income = sql<number>`coalesce(sum(case when ${isIncome} then ${t.amount} else 0 end), 0)::float8`;

/**
 * Transfers and inactive accounts never count as spending or income, and the
 * other member's personal accounts are never loaded at all.
 */
function baseWhere(viewer: Viewer, fromDate: string) {
  return and(eq(t.isTransfer, false), eq(financeAccounts.active, true), visibleTo(viewer), gte(t.postedDate, fromDate));
}

export async function loadCategoryFacts(viewer: Viewer, fromDate: string): Promise<CategoryFact[]> {
  const rows = await db()
    .select({
      month,
      accountId: t.accountId,
      owner: financeAccounts.owner,
      category: sql<string>`coalesce(${t.category}, 'Uncategorized')`,
      subcategory: t.subcategory,
      spend,
      income,
      count: sql<number>`count(*)::int`,
    })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(baseWhere(viewer, fromDate))
    .groupBy(month, t.accountId, financeAccounts.owner, sql`coalesce(${t.category}, 'Uncategorized')`, t.subcategory);
  return rows.map((r) => ({ ...r, owner: r.owner as OwnerKey, spend: Number(r.spend), income: Number(r.income) }));
}

export async function loadMerchantFacts(viewer: Viewer, fromDate: string): Promise<MerchantFact[]> {
  const rows = await db()
    .select({
      month,
      accountId: t.accountId,
      owner: financeAccounts.owner,
      merchant: t.merchant,
      spend,
      count: sql<number>`count(*)::int`,
    })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(and(baseWhere(viewer, fromDate), sql`not ${isIncome}`))
    .groupBy(month, t.accountId, financeAccounts.owner, t.merchant);
  return rows.map((r) => ({ ...r, owner: r.owner as OwnerKey, spend: Number(r.spend) }));
}
