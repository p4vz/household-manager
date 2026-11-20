/**
 * The shape of one card product's published terms, as stored in the card
 * catalog. Used to validate the seed file, the AI refresh output and the
 * stored JSON. Pure: no DB, no network.
 */
import { z } from "zod";

/**
 * Spend categories a card can reward. Each maps to the household's own
 * category/subcategory names in `categories.ts`. A multiplier can also
 * target a merchant with `merchant:<name>` (e.g. `merchant:Amazon`).
 */
export const CATALOG_CATEGORIES = [
  "dining",
  "groceries",
  "gas",
  "ev_charging",
  "travel",
  "flights",
  "hotels",
  "car_rental",
  "transit",
  "streaming",
  "entertainment",
  "drugstores",
  "home_improvement",
  "utilities",
  "online_shopping",
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

const CapPeriod = z.enum(["month", "quarter", "year"]);
const On = z
  .string()
  .min(1)
  .max(80)
  .refine((s) => (CATALOG_CATEGORIES as readonly string[]).includes(s) || /^merchant:.+/.test(s), {
    message: `must be one of ${CATALOG_CATEGORIES.join(", ")} or merchant:<name>`,
  });

export const Multiplier = z.object({
  on: On,
  rate: z.number().min(0).max(100),
  capAmount: z.number().min(0).nullable(),
  capPeriod: CapPeriod.nullable(),
  /** e.g. "booked through Chase Travel", "on the first $6,000 per year". */
  note: z.string().max(200).nullable(),
});
export type Multiplier = z.infer<typeof Multiplier>;

export const QUARTER_RE = /^\d{4}-Q[1-4]$/;

export const Rotating = z.object({
  program: z.string().max(80),
  rate: z.number().min(0).max(100),
  capAmount: z.number().min(0).nullable(),
  activationRequired: z.boolean(),
  quarters: z.array(
    z.object({
      quarter: z.string().regex(QUARTER_RE),
      on: z.array(On).max(8),
      /** The issuer's own wording, e.g. "Amazon.com and Target". */
      description: z.string().max(200),
    }),
  ),
});
export type Rotating = z.infer<typeof Rotating>;

export const SignupOffer = z.object({
  /** Points/miles, or dollars for cash back. */
  bonus: z.number().min(0),
  minSpend: z.number().min(0),
  windowMonths: z.number().int().min(1).max(24),
  /** Anything else in the offer, e.g. "plus 0% intro APR for 15 months". */
  extras: z.string().max(200).nullable(),
  /** Last day the offer is advertised, when the issuer says. */
  endDate: z.iso.date().nullable(),
});
export type SignupOffer = z.infer<typeof SignupOffer>;

export const Credit = z.object({
  label: z.string().max(80),
  /** Dollar value per period. */
  amount: z.number().min(0),
  period: z.enum(["month", "quarter", "half-year", "year", "card-anniversary", "4-years"]),
  note: z.string().max(200).nullable(),
});

export const CardTerms = z.object({
  rewardType: z.enum(["points", "cashback"]),
  /** e.g. "Chase Ultimate Rewards", "Membership Rewards", null for plain cash back. */
  rewardCurrency: z.string().max(60).nullable(),
  annualFee: z.number().min(0).max(5000),
  baseRate: z.number().min(0).max(100),
  /** Typical value of one point in cents (1 for cash back). */
  pointValueCents: z.number().min(0).max(10),
  foreignTransactionFee: z.boolean(),
  multipliers: z.array(Multiplier).max(20),
  rotating: Rotating.nullable(),
  signupOffer: SignupOffer.nullable(),
  credits: z.array(Credit).max(20),
  perks: z.array(z.string().max(160)).max(15),
});
export type CardTerms = z.infer<typeof CardTerms>;

export const CatalogSeedEntry = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  issuer: z.string(),
  name: z.string(),
  /** Issuer domains the refresh job accepts as sources. */
  sourceDomains: z.array(z.string()).min(1),
  sourceUrls: z.array(z.url()),
  terms: CardTerms,
});
export type CatalogSeedEntry = z.infer<typeof CatalogSeedEntry>;

// ---------- quarters ----------

export function quarterOf(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

export function quarterBounds(quarter: string): { from: string; to: string } {
  const [y, q] = [Number(quarter.slice(0, 4)), Number(quarter.slice(6))];
  const from = new Date(Date.UTC(y, (q - 1) * 3, 1));
  const to = new Date(Date.UTC(y, q * 3, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function nextQuarter(quarter: string): string {
  const [y, q] = [Number(quarter.slice(0, 4)), Number(quarter.slice(6))];
  return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
}

// ---------- diffs ----------

export type TermsChange = { field: string; before: unknown; after: unknown };

const FIELDS: (keyof CardTerms)[] = [
  "annualFee",
  "baseRate",
  "pointValueCents",
  "rewardType",
  "rewardCurrency",
  "foreignTransactionFee",
  "multipliers",
  "rotating",
  "signupOffer",
  "credits",
  "perks",
];

/** Stable JSON (sorted keys) so key order never counts as a change. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Field-level differences between two versions of a card's terms. */
export function diffTerms(before: CardTerms | null, after: CardTerms): TermsChange[] {
  if (!before) return [{ field: "terms", before: null, after }];
  return FIELDS.filter((f) => stable(before[f]) !== stable(after[f])).map((f) => ({
    field: f,
    before: before[f],
    after: after[f],
  }));
}

/**
 * Rotating quarters are a calendar the issuer extends; a refresh that
 * forgets past quarters should not erase them. Keep known quarters and let
 * the new answer add or correct quarters it names.
 */
export function mergeRotating(before: Rotating | null, after: Rotating | null): Rotating | null {
  // A refresh that omits the program entirely is more likely a miss than a
  // discontinued card; keep what we had (a person can still edit it).
  if (!after) return before;
  if (!before) return after;
  const byQuarter = new Map(before.quarters.map((q) => [q.quarter, q]));
  for (const q of after.quarters) byQuarter.set(q.quarter, q);
  return { ...after, quarters: [...byQuarter.values()].sort((a, b) => a.quarter.localeCompare(b.quarter)) };
}
