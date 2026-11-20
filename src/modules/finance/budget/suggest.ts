/**
 * Auto-budget suggestions from trailing actuals (no forecasting): the
 * average of the last 3 or 6 complete months per category, optionally
 * ignoring one spike month.
 */
export type BudgetBasis = 3 | 6;
export type BudgetOptions = { basis: BudgetBasis; excludeOutliers: boolean };

export type Suggestion = {
  category: string;
  suggested: number;
  average: number;
  months: { month: string; spend: number }[];
  excludedMonth: string | null;
};

/** A month is a spike if it is over 1.5x the median of the other months (and > $50 above it). */
export function findSpike(values: number[]): number | null {
  if (values.length < 3) return null;
  let maxIdx = 0;
  values.forEach((v, i) => {
    if (v > values[maxIdx]) maxIdx = i;
  });
  const others = values.filter((_, i) => i !== maxIdx).sort((a, b) => a - b);
  const mid = Math.floor(others.length / 2);
  const median = others.length % 2 ? others[mid] : (others[mid - 1] + others[mid]) / 2;
  const max = values[maxIdx];
  return max > median * 1.5 && max - median > 50 ? maxIdx : null;
}

/** Round budgets up to a friendly number: $5 under $100, $10 under $1000, else $25. */
export function friendlyRound(n: number): number {
  if (n <= 0) return 0;
  const step = n < 100 ? 5 : n < 1000 ? 10 : 25;
  return Math.ceil(n / step) * step;
}

export function suggestBudgets(
  monthly: Map<string, { month: string; spend: number }[]>,
  opts: BudgetOptions,
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const [category, all] of monthly) {
    const months = all.slice(-opts.basis);
    if (months.length === 0) continue;
    const values = months.map((m) => Math.max(0, m.spend));
    const spikeIdx = opts.excludeOutliers ? findSpike(values) : null;
    const used = values.filter((_, i) => i !== spikeIdx);
    const average = used.reduce((sum, v) => sum + v, 0) / used.length;
    if (average < 1) continue;
    out.push({
      category,
      average: Math.round(average * 100) / 100,
      suggested: friendlyRound(average),
      months,
      excludedMonth: spikeIdx == null ? null : months[spikeIdx].month,
    });
  }
  return out.sort((a, b) => b.suggested - a.suggested);
}

export type BudgetStatus = "ok" | "warning" | "over";

/** Warning at 80% of the target, over at 100%. */
export function budgetStatus(spent: number, limit: number): BudgetStatus {
  if (limit <= 0) return spent > 0 ? "over" : "ok";
  const pct = spent / limit;
  return pct >= 1 ? "over" : pct >= 0.8 ? "warning" : "ok";
}
