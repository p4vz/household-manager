import { describe, expect, it } from "vitest";
import { planPurchases, type BonusCard, type PlannedPurchase } from "@/modules/finance/rewards/bonus";
import { expectedChargeDate, toPlannedPurchases, tripTotal, type PlannableItem } from "@/modules/trips/card-plan";

const travelCard: BonusCard = {
  accountId: "sapphire",
  name: "Sapphire",
  baseRate: 1,
  centsPerUnit: 1.5,
  annualFee: 95,
  rules: [{ id: "r1", matchType: "category", match: "Travel", rate: 3, capAmount: null, capPeriod: null, validFrom: null, validTo: null, label: null }],
  signup: null,
};
const newCard: BonusCard = {
  accountId: "venture",
  name: "Venture",
  baseRate: 2,
  centsPerUnit: 1,
  annualFee: 95,
  rules: [],
  // 75,000 miles at 1c = $750 for $4,000 by 15 Jan.
  signup: { bonus: 75_000, minSpend: 4000, start: "2026-10-20", deadline: "2027-01-15" },
};
const flight: PlannedPurchase = { ref: "f", date: "2026-11-21", amount: 2400, merchant: "United", category: "Travel", subcategory: "Air Travel" };
const hotel: PlannedPurchase = { ref: "h", date: "2026-11-21", amount: 1800, merchant: "Marriott", category: "Travel", subcategory: "Hotel" };

describe("planPurchases", () => {
  it("puts each purchase on the best multiplier when no bonus is open", () => {
    const { purchases, bonuses } = planPurchases({ cards: [travelCard, { ...newCard, signup: null }], purchases: [flight], spentToward: new Map(), today: "2026-11-20" });
    expect(purchases[0]).toMatchObject({ reason: "multiplier", recommended: { card: "Sapphire", cents: 10800 } });
    expect(bonuses).toEqual([]);
  });

  it("routes trip spend to an open sign-up bonus when it can meet the minimum", () => {
    const { purchases, bonuses } = planPurchases({
      cards: [travelCard, newCard],
      purchases: [flight, hotel],
      spentToward: new Map([["venture", 500]]),
      today: "2026-11-20",
    });
    // Needs $3,500 more; flight + hotel = $4,200.
    expect(purchases.every((p) => p.reason === "bonus" && p.recommended.card === "Venture")).toBe(true);
    expect(purchases[0].bestMultiplier.card).toBe("Sapphire");
    expect(bonuses[0]).toMatchObject({ card: "Venture", remaining: 3500, planned: 4200, metWithPlan: true, bonusValue: 750 });
  });

  it("only routes as much as the minimum needs, cheapest loss first", () => {
    const { purchases } = planPurchases({ cards: [travelCard, newCard], purchases: [flight, hotel], spentToward: new Map([["venture", 2000]]), today: "2026-11-20" });
    // $2,000 to go: the flight alone covers it; the hotel goes back to the 3x card.
    expect(purchases.find((p) => p.ref === "f")!.recommended.card).toBe("Venture");
    expect(purchases.find((p) => p.ref === "h")).toMatchObject({ reason: "multiplier", recommended: { card: "Sapphire" } });
  });

  it("does not give up multipliers for a bonus the plan cannot reach", () => {
    const { purchases, bonuses } = planPurchases({ cards: [travelCard, newCard], purchases: [hotel], spentToward: new Map(), today: "2026-11-20" });
    expect(purchases[0]).toMatchObject({ reason: "multiplier", recommended: { card: "Sapphire" } });
    expect(bonuses[0]).toMatchObject({ planned: 0, metWithPlan: false, remaining: 4000 });
  });

  it("ignores purchases charged after the deadline and expired offers", () => {
    const late = { ...flight, ref: "late", date: "2027-02-01", amount: 5000 };
    const r = planPurchases({ cards: [travelCard, newCard], purchases: [late], spentToward: new Map(), today: "2026-11-20" });
    expect(r.purchases[0].reason).toBe("multiplier");
    const expired = planPurchases({ cards: [travelCard, newCard], purchases: [flight], spentToward: new Map(), today: "2027-02-01" });
    expect(expired.bonuses).toEqual([]);
  });

  it("respects caps already used this period", () => {
    const capped: BonusCard = { ...travelCard, rules: [{ ...travelCard.rules[0], capAmount: 1000, capPeriod: "year" }] };
    const usage = new Map([["sapphire|r1|2026", 900]]);
    const { purchases } = planPurchases({ cards: [capped, { ...newCard, signup: null }], purchases: [flight], spentToward: new Map(), capUsage: usage, today: "2026-11-20" });
    // $100 left at 3x (450c) + $2,300 at 1x (3450c) = 3900c < Venture 2x = 4800c.
    expect(purchases[0].recommended).toMatchObject({ card: "Venture", cents: 4800 });
  });
});

const item = (over: Partial<PlannableItem>): PlannableItem => ({
  id: "i",
  kind: "flight",
  title: "PHL to ZRH",
  provider: "American Airlines",
  cost: 1000,
  bookingStatus: "needs_booking",
  paidWithAccountId: null,
  chargeDate: null,
  bookingOpensOn: null,
  ...over,
});

describe("trip steps as planned purchases", () => {
  it("maps kinds to the categories card rules match, with the provider as merchant", () => {
    const [p] = toPlannedPurchases([item({})], "2026-11-20");
    expect(p).toEqual({ ref: "i", date: "2026-11-20", amount: 1000, merchant: "American Airlines", category: "Travel", subcategory: "Air Travel" });
  });

  it("skips paid, cancelled, uncosted and non-purchase steps", () => {
    const out = toPlannedPurchases(
      [item({ id: "a", paidWithAccountId: "x" }), item({ id: "b", bookingStatus: "cancelled" }), item({ id: "c", cost: null }), item({ id: "d", kind: "note" })],
      "2026-11-20",
    );
    expect(out).toEqual([]);
  });

  it("expects the charge when sales open, or today", () => {
    expect(expectedChargeDate(item({ bookingOpensOn: "2027-01-10" }), "2026-11-20")).toBe("2027-01-10");
    expect(expectedChargeDate(item({ chargeDate: "2026-01-01" }), "2026-11-20")).toBe("2026-11-20");
    expect(expectedChargeDate(item({ chargeDate: "2026-12-01" }), "2026-11-20")).toBe("2026-12-01");
  });

  it("totals the trip from step costs when there is no budget", () => {
    expect(tripTotal(null, [{ cost: 100, bookingStatus: "booked" }, { cost: 50.5, bookingStatus: "cancelled" }, { cost: 20.25, bookingStatus: "idea" }])).toBe(120.25);
    expect(tripTotal(3000, [{ cost: 100, bookingStatus: "booked" }])).toBe(3000);
    expect(tripTotal(null, [])).toBeNull();
  });
});
