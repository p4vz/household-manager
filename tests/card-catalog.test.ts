import { describe, expect, it } from "vitest";
import { CATEGORY_MATCHERS, matchersFor, rotatingRules, rulesFromTerms } from "@/modules/finance/rewards/catalog/categories";
import { compareCatalog, signupDollars } from "@/modules/finance/rewards/catalog/compare";
import { isDue, httpsOnly, issuerSources, rotatingGap, suspiciousReason } from "@/modules/finance/rewards/catalog/refresh";
import { CATALOG_SEED } from "@/modules/finance/rewards/catalog/seed";
import { CATALOG_CATEGORIES, CardTerms, diffTerms, mergeRotating, quarterBounds, quarterOf } from "@/modules/finance/rewards/catalog/terms";
import { auditRewards, optimalValue, type Card, type SpendTxn } from "@/modules/finance/rewards/engine";

const base: CardTerms = {
  rewardType: "points",
  rewardCurrency: "Test Points",
  annualFee: 95,
  baseRate: 1,
  pointValueCents: 1.25,
  foreignTransactionFee: false,
  multipliers: [{ on: "dining", rate: 3, capAmount: null, capPeriod: null, note: null }],
  rotating: null,
  signupOffer: null,
  credits: [],
  perks: [],
};

const txn = (id: string, date: string, amount: number, category: string | null, subcategory: string | null, accountId = "held"): SpendTxn => ({
  id,
  accountId,
  date,
  amount,
  merchant: "Somewhere",
  category,
  subcategory,
});

describe("catalog seed", () => {
  it("every seed card is valid, unique, and maps to household categories", () => {
    const ids = new Set<string>();
    for (const s of CATALOG_SEED) {
      expect(CardTerms.safeParse(s.terms).success, s.id).toBe(true);
      expect(ids.has(s.id), s.id).toBe(false);
      ids.add(s.id);
      expect(s.sourceUrls.every((u) => s.sourceDomains.some((d) => new URL(u).hostname.endsWith(d))), s.id).toBe(true);
      for (const m of s.terms.multipliers) expect(matchersFor(m.on).length, `${s.id} ${m.on}`).toBeGreaterThan(0);
      // Offers change too often to ship; the first refresh fills them in.
      expect(s.terms.signupOffer).toBeNull();
    }
    for (const c of CATALOG_CATEGORIES) expect(CATEGORY_MATCHERS[c].length).toBeGreaterThan(0);
  });
});

describe("terms helpers", () => {
  it("quarters", () => {
    expect(quarterOf("2026-11-20")).toBe("2026-Q4");
    expect(quarterBounds("2026-Q1")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(quarterBounds("2024-Q1").to).toBe("2024-03-31");
  });

  it("diffs by field and ignores key order", () => {
    expect(diffTerms(base, { ...base })).toEqual([]);
    const reordered = { ...base, multipliers: [{ note: null, capPeriod: null, capAmount: null, rate: 3, on: "dining" }] };
    expect(diffTerms(base, reordered)).toEqual([]);
    const changed = diffTerms(base, { ...base, annualFee: 150, perks: ["Lounge"] });
    expect(changed.map((c) => c.field)).toEqual(["annualFee", "perks"]);
    expect(diffTerms(null, base)).toEqual([{ field: "terms", before: null, after: base }]);
  });

  it("merging rotating keeps known quarters and lets new answers correct them", () => {
    const before = { program: "5%", rate: 5, capAmount: 1500, activationRequired: true, quarters: [
      { quarter: "2026-Q3", on: ["gas"], description: "Gas" },
      { quarter: "2026-Q4", on: ["online_shopping"], description: "Amazon" },
    ] };
    const after = { ...before, quarters: [
      { quarter: "2026-Q4", on: ["online_shopping", "drugstores"], description: "Amazon and drugstores" },
      { quarter: "2027-Q1", on: ["groceries"], description: "Grocery stores" },
    ] };
    expect(mergeRotating(before, after)!.quarters.map((q) => q.description)).toEqual(["Gas", "Amazon and drugstores", "Grocery stores"]);
    expect(mergeRotating(before, null)).toEqual(before);
  });
});

describe("catalog -> engine rules", () => {
  it("one multiplier over several categories shares one cap", () => {
    const terms: CardTerms = { ...base, multipliers: [{ on: "dining", rate: 4, capAmount: 1000, capPeriod: "year", note: null }] };
    const card: Card = { accountId: "c", name: "C", baseRate: 1, centsPerUnit: 1, annualFee: 0, rules: rulesFromTerms("c", terms) };
    expect(card.rules.length).toBe(CATEGORY_MATCHERS.dining.length);
    const txns = [txn("1", "2026-01-05", 800, "Food & Dining", "Restaurants", "c"), txn("2", "2026-01-06", 800, "Food & Dining", "Coffee Shops", "c")];
    // $1,000 at 4x + $600 at 1x = 4,600 points at 1c.
    expect(auditRewards([card], txns).totalEarned).toBeCloseTo(46);
  });

  it("rotating quarters become date-windowed quarterly-capped rules", () => {
    const terms: CardTerms = {
      ...base,
      rotating: { program: "5%", rate: 5, capAmount: 1500, activationRequired: true, quarters: [{ quarter: "2026-Q4", on: ["gas", "merchant:Amazon"], description: "Gas and Amazon" }] },
    };
    const rules = rotatingRules("flex", terms);
    expect(rules.every((r) => r.validFrom === "2026-10-01" && r.validTo === "2026-12-31" && r.capPeriod === "quarter")).toBe(true);
    expect(new Set(rules.map((r) => r.capGroup))).toEqual(new Set(["flex:2026-Q4"]));
    expect(rules).toContainEqual(expect.objectContaining({ matchType: "merchant", match: "Amazon", rate: 5 }));
  });
});

describe("pricing cards the household does not hold", () => {
  const held: Card = { accountId: "held", name: "Held 1%", baseRate: 1, centsPerUnit: 1, annualFee: 0, rules: [] };
  const txns = [
    ...Array.from({ length: 12 }, (_, i) => txn(`d${i}`, `2026-${String(i + 1).padStart(2, "0")}-10`, 300, "Food & Dining", "Restaurants")),
    ...Array.from({ length: 12 }, (_, i) => txn(`g${i}`, `2026-${String(i + 1).padStart(2, "0")}-12`, 100, "Food & Dining", "Groceries")),
  ];

  it("values a candidate as what it adds over the held cards, minus its fee", () => {
    expect(optimalValue([held], txns)).toBeCloseTo(48);
    const ranked = compareCatalog([held], txns, [
      { id: "dining", issuer: "X", name: "Dining 4x", verifiedAt: null, terms: { ...base, annualFee: 95, pointValueCents: 1, multipliers: [{ on: "dining", rate: 4, capAmount: null, capPeriod: null, note: null }] } },
      { id: "flat", issuer: "Y", name: "Flat 2%", verifiedAt: null, terms: { ...base, rewardType: "cashback", annualFee: 0, baseRate: 2, pointValueCents: 1, multipliers: [], signupOffer: { bonus: 200, minSpend: 500, windowMonths: 3, extras: null, endDate: null } } },
    ]);
    // Ranked by net per year plus the sign-up bonus.
    expect(ranked.map((r) => r.id)).toEqual(["flat", "dining"]);
    const [cash, gold] = ranked;
    // Dining card: $3,600 dining at 4% instead of 1% = +$108, minus $95.
    expect(gold).toMatchObject({ id: "dining", addedRewards: 108, netPerYear: 13, signupValue: 0 });
    // Flat 2%: +1% on $4,800 = $48, no fee, plus a $200 cash bonus.
    expect(cash).toMatchObject({ id: "flat", addedRewards: 48, netPerYear: 48, signupValue: 200 });
  });

  it("sign-up values: cash back in dollars, points at the point value", () => {
    const offer = { bonus: 60000, minSpend: 4000, windowMonths: 3, extras: null, endDate: null };
    expect(signupDollars({ ...base, signupOffer: offer })).toBe(750);
    expect(signupDollars({ ...base, rewardType: "cashback", pointValueCents: 1, signupOffer: { ...offer, bonus: 200 } })).toBe(200);
  });
});

describe("refresh policy", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const verified = { status: "verified" as const, lastError: null, terms: base };

  it("checks held cards weekly and others monthly; unverified at once; backs off after errors", () => {
    expect(isDue({ ...verified, checkedAt: daysAgo(8) }, true, now)).toBe(true);
    expect(isDue({ ...verified, checkedAt: daysAgo(8) }, false, now)).toBe(false);
    expect(isDue({ ...verified, checkedAt: daysAgo(31) }, false, now)).toBe(true);
    expect(isDue({ status: "seed", checkedAt: null, lastError: null, terms: base }, false, now)).toBe(true);
    expect(isDue({ status: "seed", checkedAt: daysAgo(0.5), lastError: "boom", terms: base }, false, now)).toBe(false);
  });

  it("re-checks rotating cards until the quarter's categories are known", () => {
    const rot = (quarters: string[]): CardTerms => ({
      ...base,
      rotating: { program: "5%", rate: 5, capAmount: 1500, activationRequired: true, quarters: quarters.map((q) => ({ quarter: q, on: ["gas"], description: "Gas" })) },
    });
    expect(rotatingGap(rot([]), now)).toBe("2026-Q4");
    // Nov 20 is more than 3 weeks before Dec 31: next quarter not needed yet.
    expect(rotatingGap(rot(["2026-Q4"]), now)).toBeNull();
    expect(rotatingGap(rot(["2026-Q4"]), new Date("2026-12-15T12:00:00Z"))).toBe("2027-Q1");
    expect(isDue({ ...verified, terms: rot([]), checkedAt: daysAgo(3) }, false, now)).toBe(true);
    expect(isDue({ ...verified, terms: rot(["2026-Q4"]), checkedAt: daysAgo(3) }, false, now)).toBe(false);
  });

  it("accepts only issuer sources, including Gemini's grounding redirects titled with the domain", () => {
    expect(
      issuerSources(
        [
          { url: "https://creditcards.chase.com/rewards-credit-cards/sapphire/preferred", title: null },
          { url: "https://www.nerdwallet.com/x", title: "nerdwallet.com" },
          { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "chase.com" },
          "https://notchase.com/fake",
          "not a url",
        ],
        ["chase.com"],
      ),
    ).toEqual(["https://creditcards.chase.com/rewards-credit-cards/sapphire/preferred", "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"]);
  });

  it("rejects non-https and off-domain URLs", () => {
    const bad = ["javascript://chase.com/%0Aalert(1)", "data://chase.com/x", "http://www.chase.com/x", "https://evil.com/chase.com"];
    expect(issuerSources(bad, ["chase.com"])).toEqual([]);
    expect(issuerSources(bad.slice(0, 3).map((url) => ({ url, title: "chase.com" })), ["chase.com"])).toEqual([]);
    expect(issuerSources(["https://www.chase.com/x"], ["chase.com"])).toEqual(["https://www.chase.com/x"]);
  });

  it("without issuer domains keeps only https URLs", () => {
    expect(httpsOnly(["javascript:alert(1)", "data:text/html,x", "http://a.com", "nope", "https://a.com/x"])).toEqual(["https://a.com/x"]);
  });

  it("holds large changes for review", () => {
    expect(suspiciousReason(base, { ...base, annualFee: 150 })).toBeNull();
    expect(suspiciousReason(base, { ...base, annualFee: 795 })).toMatch(/Annual fee/);
    expect(suspiciousReason(base, { ...base, baseRate: 2 })).toMatch(/Base rate/);
  });
});
