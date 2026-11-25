import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/core/db/client";
import { ruleKey } from "./ingest/categorize";
import { visibleTo, type Viewer } from "./access";
import { financeAccounts, financeCategoryRules, financeTransactions as t } from "./schema";

/**
 * What the in-app assistant (src/assistant) may read and edit in finance.
 * Every function takes the signed-in member (`viewer`) first and only sees
 * joint accounts and the viewer's own: the other member's personal accounts
 * stay private, as everywhere else in the app.
 *
 * Editable transaction fields are the ones a person can change by hand
 * (category, subcategory, notes, transfer flag). Amounts, dates, merchants
 * and accounts come from the bank and are never edited here.
 */

const accountName = sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`;

export async function assistantAccounts(viewer: Viewer) {
  return db()
    .select({
      id: financeAccounts.id,
      name: accountName,
      owner: financeAccounts.owner,
      kind: financeAccounts.kind,
      active: financeAccounts.active,
      balance: financeAccounts.balance,
    })
    .from(financeAccounts)
    .where(visibleTo(viewer))
    .orderBy(asc(financeAccounts.owner), asc(accountName));
}

export type TransactionSearch = {
  from?: string;
  to?: string;
  /** Matches merchant or description (case-insensitive, substring). */
  text?: string;
  category?: string;
  uncategorizedOnly?: boolean;
  accountIds?: string[];
  minAmount?: number;
  maxAmount?: number;
  includeTransfers?: boolean;
  limit?: number;
};

export const MAX_SEARCH_ROWS = 300;

export async function searchTransactions(viewer: Viewer, q: TransactionSearch) {
  const where: SQL[] = [visibleTo(viewer)];
  if (q.from) where.push(gte(t.postedDate, q.from));
  if (q.to) where.push(lte(t.postedDate, q.to));
  if (q.text) {
    const like = `%${q.text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(t.merchant, like), ilike(t.description, like))!);
  }
  if (q.uncategorizedOnly) where.push(isNull(t.category));
  else if (q.category) where.push(eq(t.category, q.category));
  if (q.accountIds) where.push(inArray(t.accountId, q.accountIds.length ? q.accountIds : ["00000000-0000-0000-0000-000000000000"]));
  if (q.minAmount != null) where.push(gte(t.amount, q.minAmount));
  if (q.maxAmount != null) where.push(lte(t.amount, q.maxAmount));
  if (!q.includeTransfers) where.push(eq(t.isTransfer, false));
  const limit = Math.min(Math.max(q.limit ?? 100, 1), MAX_SEARCH_ROWS);
  const rows = await db()
    .select({
      id: t.id,
      date: t.postedDate,
      merchant: t.merchant,
      category: t.category,
      subcategory: t.subcategory,
      amount: t.amount,
      pending: t.pending,
      isTransfer: t.isTransfer,
      notes: t.notes,
      accountId: t.accountId,
      account: accountName,
      owner: financeAccounts.owner,
    })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(and(...where))
    .orderBy(desc(t.postedDate), asc(t.merchant))
    .limit(limit + 1);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Categories in use on visible transactions, with counts and totals. */
export async function categoryCounts(viewer: Viewer) {
  return db()
    .select({
      category: t.category,
      subcategory: t.subcategory,
      count: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${t.amount}), 0)::float`,
    })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(visibleTo(viewer))
    .groupBy(t.category, t.subcategory)
    .orderBy(asc(t.category), asc(t.subcategory));
}

/** Spending (outflows, net of refunds, transfers excluded) per month and category. */
export async function monthlySpendByCategory(viewer: Viewer, from: string, to: string) {
  const month = sql<string>`to_char(${t.postedDate}, 'YYYY-MM')`;
  return db()
    .select({
      month,
      category: sql<string>`coalesce(${t.category}, 'Uncategorized')`,
      spend: sql<number>`(-sum(${t.amount}))::float`,
      count: sql<number>`count(*)::int`,
    })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(
      and(
        visibleTo(viewer),
        eq(t.isTransfer, false),
        gte(t.postedDate, from),
        lte(t.postedDate, to),
        sql`coalesce(${t.category}, '') not ilike 'income%'`,
      ),
    )
    .groupBy(month, sql`coalesce(${t.category}, 'Uncategorized')`)
    .orderBy(month);
}

export type TransactionEditable = {
  category: string | null;
  subcategory: string | null;
  notes: string | null;
  isTransfer: boolean;
};

/** Editable fields plus a short label, for visible transactions only. */
export async function transactionsForEdit(viewer: Viewer, ids: string[]) {
  if (!ids.length) return new Map<string, TransactionEditable & { label: string }>();
  const rows = await db()
    .select({
      id: t.id,
      category: t.category,
      subcategory: t.subcategory,
      notes: t.notes,
      isTransfer: t.isTransfer,
      date: t.postedDate,
      merchant: t.merchant,
      amount: t.amount,
    })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(and(visibleTo(viewer), inArray(t.id, ids)));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        category: r.category,
        subcategory: r.subcategory,
        notes: r.notes,
        isTransfer: r.isTransfer,
        label: `${r.date} ${r.merchant} ${r.amount < 0 ? "-" : ""}$${Math.abs(r.amount).toFixed(2)}`,
      },
    ]),
  );
}

/** Throws unless the transaction is on an account the viewer can see. */
export async function updateTransactionFields(viewer: Viewer, id: string, patch: Partial<TransactionEditable>) {
  const visible = await transactionsForEdit(viewer, [id]);
  if (!visible.has(id)) throw new Error("Transaction not found");
  await db()
    .update(t)
    .set({
      ...(patch.category !== undefined && {
        category: patch.category?.trim() || null,
        categorySource: patch.category?.trim() ? ("manual" as const) : null,
        categoryReason: null,
      }),
      ...(patch.subcategory !== undefined && { subcategory: patch.subcategory?.trim() || null }),
      ...(patch.notes !== undefined && { notes: patch.notes?.trim().slice(0, 500) || null }),
      ...(patch.isTransfer !== undefined && { isTransfer: patch.isTransfer }),
    })
    .where(eq(t.id, id));
}

// Merchant rules decide the category of newly synced transactions. Setting
// one here changes only the rule; existing transactions are edited one by one
// (so each edit can be undone).

export type MerchantRule = { category: string; subcategory: string | null };

export async function getMerchantRule(merchant: string): Promise<MerchantRule | null> {
  const [row] = await db()
    .select({ category: financeCategoryRules.category, subcategory: financeCategoryRules.subcategory })
    .from(financeCategoryRules)
    .where(eq(financeCategoryRules.merchant, ruleKey(merchant)));
  return row ?? null;
}

export async function setMerchantRule(merchant: string, rule: MerchantRule) {
  const category = rule.category.trim();
  if (!category) throw new Error("A rule needs a category");
  const subcategory = rule.subcategory?.trim() || null;
  await db()
    .insert(financeCategoryRules)
    .values({ merchant: ruleKey(merchant), category, subcategory })
    .onConflictDoUpdate({ target: financeCategoryRules.merchant, set: { category, subcategory, updatedAt: new Date() } });
}

export async function deleteMerchantRule(merchant: string) {
  await db().delete(financeCategoryRules).where(eq(financeCategoryRules.merchant, ruleKey(merchant)));
}

