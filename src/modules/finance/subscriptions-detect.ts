import type { Owner, SubscriptionCadence } from "./schema";

/**
 * Finds recurring charges (subscriptions, memberships, insurance premiums)
 * in a list of transactions: the same merchant, on the same account owner,
 * charged at a steady interval for a similar amount. Pure, so it is tested
 * without a database.
 */
export type RecurringCharge = {
  owner: Owner;
  merchantKey: string;
  name: string;
  cadence: SubscriptionCadence;
  count: number;
  lastDate: string;
  lastAmount: number;
  /** Still charging: the last charge is not overdue by much. */
  active: boolean;
  /** The latest price rise in the last year. */
  priceChange: { from: number; to: number; on: string } | null;
};

type Txn = { owner: Owner; postedDate: string; amount: number; merchant: string };

const CADENCES: { cadence: SubscriptionCadence; min: number; max: number; days: number; minCharges: number }[] = [
  { cadence: "weekly", min: 6, max: 8, days: 7, minCharges: 4 },
  { cadence: "monthly", min: 26, max: 35, days: 30.4, minCharges: 3 },
  { cadence: "quarterly", min: 84, max: 98, days: 91, minCharges: 2 },
  { cadence: "yearly", min: 350, max: 380, days: 365, minCharges: 2 },
];

const DAY = 86_400_000;
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export function detectRecurring(txns: Txn[], today: string): RecurringCharge[] {
  const groups = new Map<string, Txn[]>();
  for (const t of txns) {
    if (t.amount >= 0) continue;
    const key = t.merchant.trim().toLowerCase();
    if (!key || key === "unknown") continue;
    const g = `${t.owner}|${key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(t);
  }

  const out: RecurringCharge[] = [];
  for (const [g, list] of groups) {
    // Several charges on one day (a refund and recharge, two family plans) count once, by total.
    const byDay = new Map<string, number>();
    for (const t of list) byDay.set(t.postedDate, (byDay.get(t.postedDate) ?? 0) + -t.amount);
    const charges = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, amount: round2(amount) }));
    if (charges.length < 2) continue;

    const gaps = charges.slice(1).map((c, i) => dayNum(c.date) - dayNum(charges[i].date));
    const typical = median(gaps);
    const c = CADENCES.find((k) => typical >= k.min && typical <= k.max);
    if (!c || charges.length < c.minCharges) continue;
    // Most gaps must fit the cadence (one skipped or doubled month is fine).
    const fitting = gaps.filter((x) => x >= c.min && x <= c.max).length;
    if (fitting < Math.max(1, Math.ceil(gaps.length * 0.7))) continue;
    // Steady price: a utility bill or groceries swing too much to be a subscription.
    const amounts = charges.map((x) => x.amount);
    const mid = median(amounts);
    if (amounts.some((a) => a < mid * 0.6 || a > mid * 1.6)) continue;

    const last = charges[charges.length - 1];
    const overdueAfter = c.days * 1.5 + 5;
    const active = dayNum(today) - dayNum(last.date) <= overdueAfter;

    let priceChange: RecurringCharge["priceChange"] = null;
    for (let i = charges.length - 1; i > 0; i--) {
      const from = charges[i - 1].amount;
      const to = charges[i].amount;
      if (to - from >= Math.max(0.5, from * 0.02)) {
        if (dayNum(today) - dayNum(charges[i].date) <= 365) priceChange = { from, to, on: charges[i].date };
        break;
      }
      if (from - to >= Math.max(0.5, from * 0.02)) break;
    }

    const cut = g.indexOf("|");
    const owner = g.slice(0, cut) as Owner;
    const merchantKey = g.slice(cut + 1);
    out.push({
      owner,
      merchantKey,
      name: list[list.length - 1].merchant.trim(),
      cadence: c.cadence,
      count: charges.length,
      lastDate: last.date,
      lastAmount: last.amount,
      active,
      priceChange,
    });
  }
  return out;
}

/** What it costs per month, whatever the cadence. */
export function monthlyCost(amount: number | null, cadence: SubscriptionCadence): number {
  if (amount == null) return 0;
  const perMonth = { weekly: (amount * 52) / 12, monthly: amount, quarterly: amount / 3, yearly: amount / 12 }[cadence];
  return round2(perMonth);
}

/** The next charge after `last`, rolled forward past today. */
export function nextChargeDate(last: string, cadence: SubscriptionCadence, today: string): string {
  const d = new Date(`${last}T00:00:00Z`);
  const day = d.getUTCDate();
  const step = () => {
    if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
    else {
      const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + months);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay));
    }
  };
  step();
  for (let i = 0; i < 600 && d.toISOString().slice(0, 10) < today; i++) step();
  return d.toISOString().slice(0, 10);
}
