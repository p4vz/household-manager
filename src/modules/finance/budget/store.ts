import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { getSetting, setSetting } from "@/core/settings/store";
import { visibleTo, type Viewer } from "../access";
import { isIncome } from "../analytics/load";
import { financeAccounts, financeBudgets, financeTransactions as t } from "../schema";
import { budgetStatus, suggestBudgets, type BudgetOptions } from "./suggest";

const OPTIONS_KEY = "finance.budget";
const DEFAULT_OPTIONS: BudgetOptions = { basis: 3, excludeOutliers: true };

export async function getBudgetOptions(): Promise<BudgetOptions> {
  const v = (await getSetting(OPTIONS_KEY)) as Partial<BudgetOptions> | undefined;
  return {
    basis: v?.basis === 6 ? 6 : 3,
    excludeOutliers: v?.excludeOutliers ?? DEFAULT_OPTIONS.excludeOutliers,
  };
}

export async function saveBudgetOptions(opts: BudgetOptions) {
  await setSetting(OPTIONS_KEY, opts);
}

function monthStart(d: Date, offset = 0): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
}

/** Spend per category per month in [from, to), over the accounts this member can see. */
async function spendByCategoryMonth(viewer: Viewer, from: string, to: string) {
  const month = sql<string>`to_char(${t.postedDate}, 'YYYY-MM')`;
  const category = sql<string>`coalesce(${t.category}, 'Uncategorized')`;
  return db()
    .select({
      month,
      category,
      spend: sql<number>`coalesce(sum(-${t.amount}), 0)::float8`,
    })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(
      and(
        eq(t.isTransfer, false),
        eq(financeAccounts.active, true),
        visibleTo(viewer),
        gte(t.postedDate, from),
        lt(t.postedDate, to),
        sql`not ${isIncome}`,
      ),
    )
    .groupBy(month, category);
}

export async function budgetOverview(viewer: Viewer, today = new Date()) {
  const opts = await getBudgetOptions();
  const historyFrom = monthStart(today, -opts.basis);
  const thisMonth = monthStart(today);
  const nextMonth = monthStart(today, 1);

  const [history, current, saved] = await Promise.all([
    spendByCategoryMonth(viewer, historyFrom, thisMonth),
    spendByCategoryMonth(viewer, thisMonth, nextMonth),
    db().select().from(financeBudgets).where(eq(financeBudgets.viewer, viewer)),
  ]);

  // Every complete month counts, including months with no spend in a category.
  const months = Array.from({ length: opts.basis }, (_, i) => monthStart(today, i - opts.basis).slice(0, 7));
  const monthly = new Map<string, { month: string; spend: number }[]>();
  for (const cat of new Set(history.map((h) => h.category))) {
    monthly.set(
      cat,
      months.map((m) => ({ month: m, spend: Number(history.find((h) => h.category === cat && h.month === m)?.spend ?? 0) })),
    );
  }
  const suggestions = suggestBudgets(monthly, opts);
  const spentNow = new Map(current.map((c) => [c.category, Number(c.spend)]));

  const categories = new Set([...suggestions.map((s) => s.category), ...saved.map((b) => b.category)]);
  const rows = [...categories].map((category) => {
    const suggestion = suggestions.find((s) => s.category === category) ?? null;
    const budget = saved.find((b) => b.category === category) ?? null;
    const spent = Math.max(0, spentNow.get(category) ?? 0);
    const limit = budget?.monthlyLimit ?? null;
    return {
      category,
      suggestion,
      budget: budget ? { limit: budget.monthlyLimit, source: budget.source } : null,
      spent: Math.round(spent * 100) / 100,
      status: limit != null ? budgetStatus(spent, limit) : null,
      pct: limit ? spent / limit : null,
    };
  });
  rows.sort((a, b) => (b.budget?.limit ?? b.suggestion?.suggested ?? 0) - (a.budget?.limit ?? a.suggestion?.suggested ?? 0));
  return { options: opts, month: thisMonth.slice(0, 7), rows };
}

export async function setBudget(viewer: Viewer, category: string, monthlyLimit: number, source: "auto" | "manual") {
  await db()
    .insert(financeBudgets)
    .values({ viewer, category, monthlyLimit, source })
    .onConflictDoUpdate({
      target: [financeBudgets.viewer, financeBudgets.category],
      set: { monthlyLimit, source, updatedAt: new Date() },
    });
}

export async function removeBudget(viewer: Viewer, category: string) {
  await db().delete(financeBudgets).where(and(eq(financeBudgets.viewer, viewer), eq(financeBudgets.category, category)));
}

/** One click: accept every current suggestion except manual overrides. */
export async function acceptAllSuggestions(viewer: Viewer, today = new Date()) {
  const { rows } = await budgetOverview(viewer, today);
  for (const r of rows) {
    if (r.suggestion && r.budget?.source !== "manual") await setBudget(viewer, r.category, r.suggestion.suggested, "auto");
  }
}
