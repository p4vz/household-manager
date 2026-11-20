import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, max, min, sql, type SQL } from "drizzle-orm";
import type { ModuleName } from "@/core/bus/events";
import { db } from "@/core/db/client";
import { categorizeUncategorized, setMerchantCategory } from "./ai/categorize";
import { rangeMonths, type OwnerFilter, type RangeKey } from "./analytics/compute";
import { isIncome, loadCategoryFacts, loadMerchantFacts } from "./analytics/load";
import {
  acceptAllSuggestions,
  budgetOverview,
  removeBudget,
  saveBudgetOptions,
  setBudget,
} from "./budget/store";
import { connectionInfo, storeAccessUrl } from "./ingest/credentials";
import { commitCsvImport, previewCsvImport, type AccountMapping } from "./ingest/import";
import { claimAccessUrl } from "./ingest/simplefin";
import { syncSimplefin } from "./ingest/sync";
import {
  financeAccounts,
  financeExpectedExpenses,
  financeSyncRuns,
  financeTransactions,
  type AccountKind,
  type Owner,
} from "./schema";

/**
 * Finance module public API. Pages, server actions, cron routes and other
 * modules use only these functions.
 */

// ---------- ingestion ----------

export { previewCsvImport, commitCsvImport, type AccountMapping };
export { isSyncSlot } from "./ingest/schedule";

export async function connectSimplefin(setupToken: string) {
  const accessUrl = await claimAccessUrl(setupToken);
  await storeAccessUrl(accessUrl);
  return syncSimplefin({ trigger: "setup" });
}

export async function runScheduledSync(now = new Date()) {
  const result = await syncSimplefin({ trigger: "cron", now });
  if (result.status === "ok" && result.inserted > 0 && aiConfigured()) {
    // Best effort: a provider outage must not fail the bank sync.
    await categorizeUncategorized().catch((err) =>
      console.error(`[finance] AI categorization failed: ${err instanceof Error ? err.message : err}`),
    );
  }
  return result;
}

function aiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

export { categorizeUncategorized, setMerchantCategory };

export async function syncStatus() {
  const connection = await connectionInfo();
  const runs = await db()
    .select({
      status: financeSyncRuns.status,
      startedAt: financeSyncRuns.startedAt,
      inserted: financeSyncRuns.inserted,
      messages: financeSyncRuns.messages,
    })
    .from(financeSyncRuns)
    .orderBy(desc(financeSyncRuns.startedAt))
    .limit(5);
  const [totals] = await db()
    .select({ n: count(), first: min(financeTransactions.postedDate), last: max(financeTransactions.postedDate) })
    .from(financeTransactions);
  return { connection, runs, totals };
}

// ---------- accounts ----------

export async function listAccounts() {
  return db()
    .select({
      id: financeAccounts.id,
      bankName: financeAccounts.bankName,
      institution: financeAccounts.institution,
      displayName: financeAccounts.displayName,
      owner: financeAccounts.owner,
      kind: financeAccounts.kind,
      active: financeAccounts.active,
      balance: financeAccounts.balance,
      currency: financeAccounts.currency,
      linked: financeAccounts.simplefinId,
      simplefinStartDate: financeAccounts.simplefinStartDate,
    })
    .from(financeAccounts)
    .orderBy(asc(financeAccounts.owner), asc(financeAccounts.bankName));
}

export async function updateAccount(
  id: string,
  patch: { displayName: string | null; owner: Owner; kind: AccountKind; active: boolean },
) {
  await db()
    .update(financeAccounts)
    .set({ ...patch, displayName: patch.displayName?.trim() || null })
    .where(eq(financeAccounts.id, id));
}

// ---------- transactions ----------

export async function listRecentTransactions(limit = 100) {
  return db()
    .select({
      id: financeTransactions.id,
      date: financeTransactions.postedDate,
      merchant: financeTransactions.merchant,
      category: financeTransactions.category,
      subcategory: financeTransactions.subcategory,
      amount: financeTransactions.amount,
      pending: financeTransactions.pending,
      isTransfer: financeTransactions.isTransfer,
      source: financeTransactions.source,
      account: financeAccounts.displayName,
      bankName: financeAccounts.bankName,
      owner: financeAccounts.owner,
    })
    .from(financeTransactions)
    .innerJoin(financeAccounts, eq(financeTransactions.accountId, financeAccounts.id))
    .orderBy(desc(financeTransactions.postedDate))
    .limit(limit);
}

// ---------- insights ----------

/** Everything the dashboard needs; filtering happens in the browser. */
export async function dashboardData(today = new Date()) {
  const months = rangeMonths("12M", today);
  const from = `${months[0]}-01`;
  const [categoryFacts, merchantFacts, accounts] = await Promise.all([
    loadCategoryFacts(from),
    loadMerchantFacts(from),
    db()
      .select({
        id: financeAccounts.id,
        name: sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`,
        owner: financeAccounts.owner,
      })
      .from(financeAccounts)
      .where(eq(financeAccounts.active, true))
      .orderBy(asc(financeAccounts.owner)),
  ]);
  return { today: today.toISOString().slice(0, 10), categoryFacts, merchantFacts, accounts };
}

export type DrillDown = {
  range: RangeKey;
  owner: OwnerFilter;
  accountIds: string[] | null;
  category?: string;
  subcategory?: string | null;
  merchant?: string;
};

export async function drillDownTransactions(q: DrillDown, today = new Date()) {
  const months = rangeMonths(q.range, today);
  const [y, m] = months[months.length - 1].split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const where: SQL[] = [
    eq(financeTransactions.isTransfer, false),
    eq(financeAccounts.active, true),
    gte(financeTransactions.postedDate, `${months[0]}-01`),
    lt(financeTransactions.postedDate, end),
  ];
  if (q.owner !== "all") where.push(eq(financeAccounts.owner, q.owner));
  if (q.accountIds?.length) where.push(inArray(financeTransactions.accountId, q.accountIds));
  if (q.category === "Uncategorized") where.push(isNull(financeTransactions.category));
  else if (q.category) where.push(eq(financeTransactions.category, q.category));
  if (q.subcategory === "Other") where.push(isNull(financeTransactions.subcategory));
  else if (q.subcategory) where.push(eq(financeTransactions.subcategory, q.subcategory));
  if (q.merchant) where.push(eq(financeTransactions.merchant, q.merchant), sql`not ${isIncome}`);

  return db()
    .select({
      id: financeTransactions.id,
      date: financeTransactions.postedDate,
      merchant: financeTransactions.merchant,
      category: financeTransactions.category,
      subcategory: financeTransactions.subcategory,
      amount: financeTransactions.amount,
      account: sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`,
      owner: financeAccounts.owner,
    })
    .from(financeTransactions)
    .innerJoin(financeAccounts, eq(financeTransactions.accountId, financeAccounts.id))
    .where(and(...where))
    .orderBy(desc(financeTransactions.postedDate))
    .limit(500);
}

// ---------- budgets ----------

export { budgetOverview, setBudget, removeBudget, acceptAllSuggestions, saveBudgetOptions };

// ---------- cross-module ----------

export type ExpectedExpense = {
  title: string;
  date: string;
  amount: number;
  category?: string | null;
};

/** Record a known upcoming cost owned by another module. Idempotent. */
export async function upsertExpectedExpense(
  source: { module: ModuleName; ref: string },
  expense: ExpectedExpense,
) {
  await db()
    .insert(financeExpectedExpenses)
    .values({
      ...expense,
      category: expense.category ?? null,
      sourceModule: source.module,
      sourceRef: source.ref,
    })
    .onConflictDoUpdate({
      target: [financeExpectedExpenses.sourceModule, financeExpectedExpenses.sourceRef],
      set: { title: expense.title, date: expense.date, amount: expense.amount },
    });
}

export async function removeExpectedExpense(source: { module: ModuleName; ref: string }) {
  await db()
    .delete(financeExpectedExpenses)
    .where(
      and(
        eq(financeExpectedExpenses.sourceModule, source.module),
        eq(financeExpectedExpenses.sourceRef, source.ref),
      ),
    );
}

export async function listExpectedExpenses(fromDate: string) {
  return db()
    .select({
      title: financeExpectedExpenses.title,
      date: financeExpectedExpenses.date,
      amount: financeExpectedExpenses.amount,
      category: financeExpectedExpenses.category,
      sourceModule: financeExpectedExpenses.sourceModule,
    })
    .from(financeExpectedExpenses)
    .where(gte(financeExpectedExpenses.date, fromDate))
    .orderBy(asc(financeExpectedExpenses.date));
}

export const OWNER_LABELS: Record<Owner, string> = { user1: "Me", user2: "Wife", joint: "Joint" };
export { OWNERS, ACCOUNT_KINDS, type Owner, type AccountKind } from "./schema";
