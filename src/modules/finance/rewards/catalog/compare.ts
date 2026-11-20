/**
 * Price catalog cards against the household's real spending. Pure code.
 *
 * For each card the household does not hold, the yearly value is what it
 * would add on top of the cards already held (every purchase on the best
 * card, caps honoured), minus its annual fee. The sign-up bonus is shown
 * separately as a first-year extra. Credits are listed but not counted,
 * because whether they are worth face value depends on the household.
 */
import { optimalValue, type Card, type SpendTxn } from "../engine";
import { rotatingRules, rulesFromTerms } from "./categories";
import type { CardTerms } from "./terms";

export type CatalogCard = { id: string; issuer: string; name: string; terms: CardTerms; verifiedAt: Date | null };

export function catalogCardToEngine(p: CatalogCard): Card {
  return {
    accountId: `catalog:${p.id}`,
    name: `${p.issuer} ${p.name}`,
    baseRate: p.terms.baseRate,
    centsPerUnit: p.terms.pointValueCents,
    annualFee: p.terms.annualFee,
    rules: [...rulesFromTerms(p.id, p.terms), ...rotatingRules(p.id, p.terms)],
  };
}

export type CandidateValue = {
  id: string;
  card: string;
  annualFee: number;
  /** Extra rewards per year over the held cards, before the fee. */
  addedRewards: number;
  /** addedRewards - annualFee. */
  netPerYear: number;
  /** Sign-up bonus in dollars at the catalog point value (0 if none on file). */
  signupValue: number;
  signupOffer: CardTerms["signupOffer"];
  creditsPerYear: number;
  verifiedAt: string | null;
};

const PER_YEAR: Record<CardTerms["credits"][number]["period"], number> = {
  month: 12,
  quarter: 4,
  "half-year": 2,
  year: 1,
  "card-anniversary": 1,
  "4-years": 0.25,
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Cash-back offers are stated in dollars; points offers in points. */
export function signupDollars(terms: CardTerms): number {
  const o = terms.signupOffer;
  if (!o) return 0;
  return terms.rewardType === "cashback" ? o.bonus : r2((o.bonus * terms.pointValueCents) / 100);
}

/** `txns` should cover about 12 months so the result reads as per year. */
export function compareCatalog(held: Card[], txns: SpendTxn[], catalog: CatalogCard[]): CandidateValue[] {
  const baseline = optimalValue(held, txns);
  return catalog
    .map((p) => {
      const added = r2(optimalValue([...held, catalogCardToEngine(p)], txns) - baseline);
      const offer = p.terms.signupOffer;
      return {
        id: p.id,
        card: `${p.issuer} ${p.name}`,
        annualFee: p.terms.annualFee,
        addedRewards: added,
        netPerYear: r2(added - p.terms.annualFee),
        signupValue: offer ? signupDollars(p.terms) : 0,
        signupOffer: offer,
        creditsPerYear: r2(p.terms.credits.reduce((s, c) => s + c.amount * PER_YEAR[c.period], 0)),
        verifiedAt: p.verifiedAt ? p.verifiedAt.toISOString().slice(0, 10) : null,
      };
    })
    .sort((a, b) => b.netPerYear + b.signupValue - (a.netPerYear + a.signupValue));
}
