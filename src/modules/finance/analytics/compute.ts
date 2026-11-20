/**
 * Pure analytics over pre-aggregated facts. Shared by the server (loading)
 * and the browser (instant filtering), so no DB or server imports here.
 * Historical actuals only: nothing in this file projects or forecasts.
 */
export type OwnerKey = "user1" | "user2" | "joint";
export type OwnerFilter = "all" | OwnerKey;
export type RangeKey = "3M" | "6M" | "12M" | "YTD";
export const RANGES: RangeKey[] = ["3M", "6M", "12M", "YTD"];

export type CategoryFact = {
  month: string; // YYYY-MM
  accountId: string;
  owner: OwnerKey;
  category: string;
  subcategory: string | null;
  spend: number; // net outflow (refunds reduce it)
  income: number;
  count: number;
};

export type MerchantFact = {
  month: string;
  accountId: string;
  owner: OwnerKey;
  merchant: string;
  spend: number;
  count: number;
};

export type Filters = { owner: OwnerFilter; accountIds: string[] | null; range: RangeKey };

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Calendar months in the range, oldest first, ending with the current month. */
export function rangeMonths(range: RangeKey, today: Date): string[] {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const n = range === "YTD" ? m + 1 : Number(range.replace("M", ""));
  return Array.from({ length: n }, (_, i) => monthKey(new Date(Date.UTC(y, m - (n - 1 - i), 1))));
}

export function applyFilters<T extends { month: string; accountId: string; owner: OwnerKey }>(
  facts: T[],
  f: { owner: OwnerFilter; accountIds: string[] | null; months: string[] },
): T[] {
  const months = new Set(f.months);
  const accounts = f.accountIds ? new Set(f.accountIds) : null;
  return facts.filter(
    (x) => months.has(x.month) && (f.owner === "all" || x.owner === f.owner) && (!accounts || accounts.has(x.accountId)),
  );
}

export type CategorySlice = {
  category: string;
  spend: number;
  count: number;
  subcategories: { name: string; spend: number; count: number }[];
};

export function categoryBreakdown(facts: CategoryFact[]): CategorySlice[] {
  const byCat = new Map<string, CategorySlice>();
  for (const f of facts) {
    if (f.spend === 0) continue;
    const c = byCat.get(f.category) ?? { category: f.category, spend: 0, count: 0, subcategories: [] };
    c.spend += f.spend;
    c.count += f.count;
    const subName = f.subcategory ?? "Other";
    const sub = c.subcategories.find((s) => s.name === subName);
    if (sub) {
      sub.spend += f.spend;
      sub.count += f.count;
    } else c.subcategories.push({ name: subName, spend: f.spend, count: f.count });
    byCat.set(f.category, c);
  }
  return [...byCat.values()]
    .map((c) => ({
      ...c,
      spend: round(c.spend),
      subcategories: c.subcategories
        .map((s) => ({ ...s, spend: round(s.spend) }))
        .filter((s) => s.spend > 0)
        .sort((a, b) => b.spend - a.spend),
    }))
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend);
}

export type CashFlowMonth = { month: string; income: number; spend: number; net: number };

export function cashFlow(facts: CategoryFact[], months: string[]) {
  const rows = new Map<string, CashFlowMonth>(months.map((m) => [m, { month: m, income: 0, spend: 0, net: 0 }]));
  for (const f of facts) {
    const r = rows.get(f.month);
    if (!r) continue;
    r.income += f.income;
    r.spend += f.spend;
  }
  const series = [...rows.values()].map((r) => ({
    month: r.month,
    income: round(r.income),
    spend: round(r.spend),
    net: round(r.income - r.spend),
  }));
  const income = round(series.reduce((s, r) => s + r.income, 0));
  const spend = round(series.reduce((s, r) => s + r.spend, 0));
  return {
    series,
    totals: { income, spend, net: round(income - spend) },
    savingsRate: income > 0 ? (income - spend) / income : null,
  };
}

export function topMerchants(facts: MerchantFact[], limit = 10) {
  const map = new Map<string, { merchant: string; spend: number; count: number }>();
  for (const f of facts) {
    const m = map.get(f.merchant) ?? { merchant: f.merchant, spend: 0, count: 0 };
    m.spend += f.spend;
    m.count += f.count;
    map.set(f.merchant, m);
  }
  return [...map.values()]
    .map((m) => ({ ...m, spend: round(m.spend) }))
    .filter((m) => m.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, limit);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
