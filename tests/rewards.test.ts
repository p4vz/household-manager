import { describe, expect, it } from "vitest";
import { auditRewards, nextFeeDate, type Card, type SpendTxn } from "@/modules/finance/rewards/engine";

const sapphire: Card = {
  accountId: "s",
  name: "Sapphire",
  baseRate: 1,
  centsPerUnit: 1.25,
  annualFee: 95,
  rules: [{ id: "r1", matchType: "category", match: "Food & Dining", rate: 3, capAmount: null, capPeriod: null, validFrom: null, validTo: null, label: null }],
};
const doubleCash: Card = { accountId: "d", name: "Double Cash", baseRate: 2, centsPerUnit: 1, annualFee: 0, rules: [] };
const freedom: Card = {
  accountId: "f",
  name: "Freedom",
  baseRate: 1,
  centsPerUnit: 1,
  annualFee: 0,
  rules: [
    { id: "q", matchType: "category", match: "Auto & Transport", rate: 5, capAmount: 1500, capPeriod: "quarter", validFrom: "2026-10-01", validTo: "2026-12-31", label: "Q4" },
  ],
};
const tx = (p: Partial<SpendTxn>): SpendTxn => ({
  id: Math.random().toString(36).slice(2),
  accountId: "d",
  date: "2026-11-01",
  amount: 100,
  merchant: "X",
  category: "Shopping",
  subcategory: null,
  ...p,
});

describe("rewards audit", () => {
  it("flags dining on the wrong card", () => {
    const a = auditRewards([sapphire, doubleCash], [tx({ id: "t1", category: "Food & Dining" })]);
    expect(a.rows[0]).toMatchObject({ actualCard: "Double Cash", actualCents: 200, bestCard: "Sapphire", bestCents: 375, missedCents: 175 });
    expect(a.byCategory[0]).toMatchObject({ category: "Food & Dining", useCard: "Sapphire", missed: 1.75 });
  });

  it("does not flag purchases already on the best card", () => {
    const a = auditRewards([sapphire, doubleCash], [tx({ accountId: "d" })]);
    expect(a.totalMissed).toBe(0);
  });

  it("honours rotating windows and quarterly caps", () => {
    const txns = [
      tx({ id: "a", date: "2026-11-02", amount: 1000, category: "Auto & Transport" }),
      tx({ id: "b", date: "2026-11-03", amount: 1000, category: "Auto & Transport" }),
      tx({ id: "c", date: "2026-09-03", amount: 100, category: "Auto & Transport" }),
    ];
    const a = auditRewards([doubleCash, freedom], txns);
    const byId = Object.fromEntries(a.rows.map((r) => [r.txnId, r]));
    // First $1000 at 5% on Freedom.
    expect(byId.a).toMatchObject({ bestCard: "Freedom", bestCents: 5000, missedCents: 3000 });
    // Only $500 cap left: 500*5 + 500*1 = 3000c vs Double Cash 2000c.
    expect(byId.b).toMatchObject({ bestCard: "Freedom", bestCents: 3000 });
    // Before the rotating window: Double Cash wins.
    expect(byId.c).toMatchObject({ bestCard: "Double Cash", missedCents: 0 });
  });

  it("caps on the card actually used too", () => {
    const txns = [
      tx({ id: "a", accountId: "f", date: "2026-11-02", amount: 1500, category: "Auto & Transport" }),
      tx({ id: "b", accountId: "f", date: "2026-11-03", amount: 100, category: "Auto & Transport" }),
    ];
    const a = auditRewards([doubleCash, freedom], txns);
    const b = a.rows.find((r) => r.txnId === "b")!;
    expect(b).toMatchObject({ actualCents: 100, bestCard: "Double Cash", missedCents: 100 });
  });

  it("reports net value after annual fee", () => {
    const a = auditRewards([sapphire], [tx({ accountId: "s", amount: 1000, category: "Food & Dining" })]);
    expect(a.perCard[0]).toMatchObject({ card: "Sapphire", earned: 37.5, annualFee: 95, net: -57.5 });
  });

  it("computes the next annual fee date", () => {
    expect(nextFeeDate(3, new Date("2026-11-20T00:00:00Z"))).toBe("2027-03-01");
    expect(nextFeeDate(11, new Date("2026-11-20T00:00:00Z"))).toBe("2026-11-01");
    expect(nextFeeDate(12, new Date("2026-11-20T00:00:00Z"))).toBe("2026-12-01");
  });
});
