/**
 * Planning future purchases across household cards. Pure code, no AI.
 *
 * Two things decide where a planned purchase (a flight, a hotel) should go:
 *
 * 1. The multiplier: which card earns the most on it right now, given each
 *    card's bonus categories, rotating windows and how much of each cap is
 *    already used this period.
 * 2. Open sign-up bonuses: a welcome offer worth hundreds of dollars beats
 *    a 3x-vs-1x difference on almost any purchase, so if a card still needs
 *    spend before its deadline, routing planned costs there can be worth
 *    far more than the best multiplier.
 *
 * `planPurchases` routes spend to open bonuses first (cheapest multiplier
 * loss per dollar first, only purchases charged before the deadline), then
 * puts everything else on the best-multiplier card.
 */
import { record, valueOn, type Card, type Ledger, type SpendTxn } from "./engine";

export type SignupBonus = {
  /** Reward units: points, or dollars for cash back. */
  bonus: number;
  minSpend: number;
  start: string;
  deadline: string;
};

export type BonusCard = Card & { signup: SignupBonus | null };

export type PlannedPurchase = {
  /** Caller's id, e.g. an itinerary item id. */
  ref: string;
  /** When the charge will post (booking date, not travel date). */
  date: string;
  amount: number;
  merchant: string;
  category: string | null;
  subcategory: string | null;
};

export type BonusStatus = {
  accountId: string;
  card: string;
  minSpend: number;
  spent: number;
  remaining: number;
  deadline: string;
  daysLeft: number;
  /** Dollar value of the bonus at the card's cents-per-unit. */
  bonusValue: number;
  /** Planned spend routed to this card by `planPurchases`. */
  planned: number;
  /** True when spent + planned reaches the minimum. */
  metWithPlan: boolean;
};

export type CardOption = { accountId: string; card: string; cents: number };

export type PurchasePlan = {
  ref: string;
  amount: number;
  recommended: CardOption;
  /** "bonus": routed to meet a sign-up minimum; "multiplier": best earn rate. */
  reason: "bonus" | "multiplier";
  /** Best card on multiplier alone, which may differ when reason = "bonus". */
  bestMultiplier: CardOption;
  options: CardOption[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function bonusValue(card: BonusCard): number {
  return card.signup ? r2((card.signup.bonus * card.centsPerUnit) / 100) : 0;
}

/** Is the welcome offer still open and unmet on `today`? */
export function isOpenBonus(card: BonusCard, spent: number, today: string): boolean {
  const s = card.signup;
  return Boolean(s && s.minSpend > 0 && today >= s.start && today <= s.deadline && spent < s.minSpend);
}

function asTxn(p: PlannedPurchase, accountId: string): SpendTxn {
  return { id: p.ref, accountId, date: p.date, amount: p.amount, merchant: p.merchant, category: p.category, subcategory: p.subcategory };
}

function optionsFor(cards: BonusCard[], p: PlannedPurchase, ledger: Ledger) {
  return cards
    .map((c) => {
      const v = valueOn(c, asTxn(p, c.accountId), ledger);
      return { accountId: c.accountId, card: c.name, cents: r2(v.cents), use: v.use };
    })
    .sort((a, b) => b.cents - a.cents);
}

/**
 * @param spentToward spend already counted toward each card's bonus, by account id
 * @param capUsage    cap usage so far this period (from the audit's actual ledger)
 */
export function planPurchases(input: {
  cards: BonusCard[];
  purchases: PlannedPurchase[];
  spentToward: ReadonlyMap<string, number>;
  capUsage?: ReadonlyMap<string, number>;
  today: string;
}): { purchases: PurchasePlan[]; bonuses: BonusStatus[] } {
  const { cards, today } = input;
  const ledger: Ledger = new Map(input.capUsage ?? []);
  const purchases = [...input.purchases]
    .filter((p) => p.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));

  // Multiplier-only valuation, used to price the cost of routing elsewhere.
  const baseline = new Map(purchases.map((p) => [p.ref, optionsFor(cards, p, ledger)]));

  const assigned = new Map<string, string>(); // ref -> accountId
  const planned = new Map<string, number>();

  const open = cards
    .filter((c) => isOpenBonus(c, input.spentToward.get(c.accountId) ?? 0, today))
    .sort((a, b) => bonusValue(b) - bonusValue(a));

  for (const card of open) {
    let remaining = card.signup!.minSpend - (input.spentToward.get(card.accountId) ?? 0);
    const eligible = purchases
      .filter((p) => !assigned.has(p.ref) && p.date >= today && p.date <= card.signup!.deadline)
      .map((p) => {
        const opts = baseline.get(p.ref)!;
        const here = opts.find((o) => o.accountId === card.accountId)!.cents;
        return { p, lossPerDollar: (opts[0].cents - here) / p.amount };
      })
      .sort((a, b) => a.lossPerDollar - b.lossPerDollar || b.p.amount - a.p.amount);

    // Only route spend here if the plan can actually reach the minimum;
    // partial progress forgoes multipliers for a bonus that never pays out.
    const reachable = eligible.reduce((s, e) => s + e.p.amount, 0) >= remaining;
    if (!reachable) continue;

    for (const { p } of eligible) {
      if (remaining <= 0) break;
      assigned.set(p.ref, card.accountId);
      planned.set(card.accountId, (planned.get(card.accountId) ?? 0) + p.amount);
      remaining -= p.amount;
    }
  }

  const plans: PurchasePlan[] = purchases.map((p) => {
    const opts = optionsFor(cards, p, ledger);
    const best = opts[0];
    const routed = assigned.get(p.ref);
    const chosen = routed ? opts.find((o) => o.accountId === routed)! : best;
    record(ledger, chosen.use);
    const strip = ({ accountId, card, cents }: (typeof opts)[number]): CardOption => ({ accountId, card, cents });
    return {
      ref: p.ref,
      amount: p.amount,
      recommended: strip(chosen),
      reason: routed ? "bonus" : "multiplier",
      bestMultiplier: strip(best),
      options: opts.map(strip),
    };
  });

  const bonuses: BonusStatus[] = cards
    .filter((c) => c.signup && c.signup.minSpend > 0 && today <= c.signup.deadline)
    .map((c) => {
      const s = c.signup!;
      const spent = r2(input.spentToward.get(c.accountId) ?? 0);
      const plan = r2(planned.get(c.accountId) ?? 0);
      return {
        accountId: c.accountId,
        card: c.name,
        minSpend: s.minSpend,
        spent,
        remaining: r2(Math.max(0, s.minSpend - spent)),
        deadline: s.deadline,
        daysLeft: Math.max(0, daysBetween(today, s.deadline)),
        bonusValue: bonusValue(c),
        planned: plan,
        metWithPlan: spent + plan >= s.minSpend,
      };
    })
    .sort((a, b) => a.deadline.localeCompare(b.deadline));

  return { purchases: plans, bonuses };
}
