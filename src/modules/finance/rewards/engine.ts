/**
 * Deterministic rewards audit. Pure code, no AI: every spending transaction
 * on a rewards card is valued on the card used and on every active
 * household card, honouring category multipliers, rotating windows and
 * spending caps. The difference is "points left on the table".
 */
export type CardRule = {
  id: string;
  matchType: "category" | "subcategory" | "merchant";
  match: string;
  rate: number;
  capAmount: number | null;
  capPeriod: "month" | "quarter" | "year" | null;
  validFrom: string | null;
  validTo: string | null;
  label: string | null;
  /** Rules that share one cap (one catalog multiplier over several categories). Defaults to `id`. */
  capGroup?: string;
};

export type Card = {
  accountId: string;
  name: string;
  baseRate: number;
  centsPerUnit: number;
  annualFee: number;
  rules: CardRule[];
};

export type SpendTxn = {
  id: string;
  accountId: string;
  date: string;
  amount: number; // positive dollars spent
  merchant: string;
  category: string | null;
  subcategory: string | null;
};

export type TxnAudit = {
  txnId: string;
  date: string;
  merchant: string;
  category: string | null;
  subcategory: string | null;
  amount: number;
  actualCard: string;
  actualCents: number;
  bestCard: string;
  bestCents: number;
  missedCents: number;
};

function periodKey(date: string, period: CardRule["capPeriod"]): string {
  const [y, m] = date.split("-");
  if (period === "month") return `${y}-${m}`;
  if (period === "quarter") return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
  return y;
}

function matches(rule: CardRule, t: SpendTxn): boolean {
  if (rule.validFrom && t.date < rule.validFrom) return false;
  if (rule.validTo && t.date > rule.validTo) return false;
  const m = rule.match.trim().toLowerCase();
  const field = rule.matchType === "category" ? t.category : rule.matchType === "subcategory" ? t.subcategory : t.merchant;
  if (!field) return false;
  return rule.matchType === "merchant" ? field.toLowerCase().includes(m) : field.toLowerCase() === m;
}

/** Cap usage, keyed by card+rule+period. One ledger per scenario (actual vs optimal). */
export type Ledger = Map<string, number>;

/**
 * Value in cents of putting `t` on `card`, given cap usage so far. Splits
 * spend across bonus (up to the remaining cap) and base rate. Returns the
 * cap consumption to record if the card is chosen.
 */
export function valueOn(card: Card, t: SpendTxn, ledger: Ledger): { cents: number; use: [string, number] | null } {
  const base = t.amount * card.baseRate * card.centsPerUnit;
  let best = { cents: base, use: null as [string, number] | null };
  for (const rule of card.rules) {
    if (!matches(rule, t)) continue;
    let bonusSpend = t.amount;
    let key: string | null = null;
    if (rule.capAmount != null) {
      key = `${card.accountId}|${rule.capGroup ?? rule.id}|${periodKey(t.date, rule.capPeriod ?? "year")}`;
      bonusSpend = Math.max(0, Math.min(t.amount, rule.capAmount - (ledger.get(key) ?? 0)));
    }
    const cents = (bonusSpend * rule.rate + (t.amount - bonusSpend) * card.baseRate) * card.centsPerUnit;
    if (cents > best.cents) best = { cents, use: key ? [key, bonusSpend] : null };
  }
  return best;
}

export function record(ledger: Ledger, use: [string, number] | null) {
  if (use) ledger.set(use[0], (ledger.get(use[0]) ?? 0) + use[1]);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function auditRewards(cards: Card[], txns: SpendTxn[]) {
  const byId = new Map(cards.map((c) => [c.accountId, c]));
  const actualLedger: Ledger = new Map();
  const optimalLedger: Ledger = new Map();
  const rows: TxnAudit[] = [];

  for (const t of [...txns].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const used = byId.get(t.accountId);
    if (!used || t.amount <= 0) continue;
    const actual = valueOn(used, t, actualLedger);
    record(actualLedger, actual.use);

    let bestCard = used;
    let best = valueOn(used, t, optimalLedger);
    for (const c of cards) {
      if (c === used) continue;
      const v = valueOn(c, t, optimalLedger);
      if (v.cents > best.cents + 1e-9) {
        best = v;
        bestCard = c;
      }
    }
    record(optimalLedger, best.use);

    rows.push({
      txnId: t.id,
      date: t.date,
      merchant: t.merchant,
      category: t.category,
      subcategory: t.subcategory,
      amount: t.amount,
      actualCard: used.name,
      actualCents: r2(actual.cents),
      bestCard: bestCard.name,
      bestCents: r2(best.cents),
      missedCents: r2(Math.max(0, best.cents - actual.cents)),
    });
  }

  const perCard = cards.map((c) => {
    const mine = rows.filter((r) => r.actualCard === c.name);
    const spend = r2(mine.reduce((s, r) => s + r.amount, 0));
    const earned = r2(mine.reduce((s, r) => s + r.actualCents, 0) / 100);
    return { card: c.name, spend, earned, annualFee: c.annualFee, net: r2(earned - c.annualFee) };
  });

  const missedByCategory = new Map<string, { category: string; missed: number; bestCard: Map<string, number> }>();
  for (const r of rows.filter((x) => x.missedCents > 0)) {
    const key = [r.category ?? "Uncategorized", r.subcategory].filter(Boolean).join(" / ");
    const e = missedByCategory.get(key) ?? { category: key, missed: 0, bestCard: new Map() };
    e.missed += r.missedCents / 100;
    e.bestCard.set(r.bestCard, (e.bestCard.get(r.bestCard) ?? 0) + r.missedCents);
    missedByCategory.set(key, e);
  }

  return {
    /** Cap usage on the cards actually used, for planning further spend. */
    capUsage: actualLedger as ReadonlyMap<string, number>,
    totalMissed: r2(rows.reduce((s, r) => s + r.missedCents, 0) / 100),
    totalEarned: r2(rows.reduce((s, r) => s + r.actualCents, 0) / 100),
    perCard,
    byCategory: [...missedByCategory.values()]
      .map((e) => ({
        category: e.category,
        missed: r2(e.missed),
        useCard: [...e.bestCard.entries()].sort((a, b) => b[1] - a[1])[0][0],
      }))
      .sort((a, b) => b.missed - a.missed),
    topMisses: rows.filter((r) => r.missedCents > 0).sort((a, b) => b.missedCents - a.missedCents).slice(0, 20),
    rows,
  };
}

/**
 * Rewards value in dollars if every transaction went on the best of `cards`
 * (cap-aware, in date order). Used to price a card the household does not
 * hold: value(held + candidate) - value(held).
 */
export function optimalValue(cards: Card[], txns: SpendTxn[]): number {
  const ledger: Ledger = new Map();
  let cents = 0;
  for (const t of [...txns].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    if (t.amount <= 0 || cards.length === 0) continue;
    let best = valueOn(cards[0], t, ledger);
    for (const c of cards.slice(1)) {
      const v = valueOn(c, t, ledger);
      if (v.cents > best.cents + 1e-9) best = v;
    }
    record(ledger, best.use);
    cents += best.cents;
  }
  return r2(cents / 100);
}

/** Next date the annual fee posts (1st of the fee month), on or after today. */
export function nextFeeDate(feeMonth: number, today: Date): string {
  const y = today.getUTCFullYear();
  const thisYear = new Date(Date.UTC(y, feeMonth - 1, 1));
  const start = new Date(Date.UTC(y, today.getUTCMonth(), 1));
  const d = thisYear >= start ? thisYear : new Date(Date.UTC(y + 1, feeMonth - 1, 1));
  return d.toISOString().slice(0, 10);
}
