import { describe, expect, it } from "vitest";
import {
  applyFilters,
  cashFlow,
  categoryBreakdown,
  rangeMonths,
  topMerchants,
  type CategoryFact,
} from "@/modules/finance/analytics/compute";
import { budgetStatus, findSpike, friendlyRound, suggestBudgets } from "@/modules/finance/budget/suggest";

const f = (p: Partial<CategoryFact>): CategoryFact => ({
  month: "2026-11",
  accountId: "a1",
  owner: "user1",
  category: "Food & Dining",
  subcategory: "Groceries",
  spend: 0,
  income: 0,
  count: 1,
  ...p,
});

describe("ranges", () => {
  it("covers N calendar months ending this month, and YTD from January", () => {
    const today = new Date("2026-03-15T12:00:00Z");
    expect(rangeMonths("3M", today)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(rangeMonths("YTD", today)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(rangeMonths("12M", today)[0]).toBe("2025-04");
  });
});

describe("breakdowns", () => {
  const facts = [
    f({ spend: 100 }),
    f({ subcategory: "Restaurants", spend: 60, owner: "user2", accountId: "a2" }),
    f({ category: "Shopping", subcategory: null, spend: 40, owner: "joint", accountId: "a3" }),
    f({ category: "Shopping", subcategory: null, spend: -40, owner: "joint", accountId: "a3", month: "2026-10" }),
    f({ category: "Income", subcategory: "Paycheck", income: 5000, owner: "joint", accountId: "a3" }),
  ];

  it("groups categories and subcategories, dropping net refunds", () => {
    const cats = categoryBreakdown(applyFilters(facts, { owner: "all", accountIds: null, months: ["2026-10", "2026-11"] }));
    expect(cats.map((c) => [c.category, c.spend])).toEqual([["Food & Dining", 160]]);
    expect(cats[0].subcategories.map((s) => s.name)).toEqual(["Groceries", "Restaurants"]);
  });

  it("filters by owner and account", () => {
    const me = categoryBreakdown(applyFilters(facts, { owner: "user1", accountIds: null, months: ["2026-11"] }));
    expect(me[0].spend).toBe(100);
    const a2 = categoryBreakdown(applyFilters(facts, { owner: "all", accountIds: ["a2"], months: ["2026-11"] }));
    expect(a2[0].spend).toBe(60);
  });

  it("computes cash flow and savings rate", () => {
    const flow = cashFlow(applyFilters(facts, { owner: "all", accountIds: null, months: ["2026-10", "2026-11"] }), ["2026-10", "2026-11"]);
    expect(flow.series).toEqual([
      { month: "2026-10", income: 0, spend: -40, net: 40 },
      { month: "2026-11", income: 5000, spend: 200, net: 4800 },
    ]);
    expect(flow.savingsRate).toBeCloseTo((5000 - 160) / 5000);
  });

  it("ranks top merchants", () => {
    const top = topMerchants(
      [
        { month: "2026-11", accountId: "a", owner: "user1", merchant: "Costco", spend: 300, count: 2 },
        { month: "2026-11", accountId: "b", owner: "user2", merchant: "Costco", spend: 100, count: 1 },
        { month: "2026-11", accountId: "a", owner: "user1", merchant: "Shell", spend: 80, count: 2 },
      ],
      1,
    );
    expect(top).toEqual([{ merchant: "Costco", spend: 400, count: 3 }]);
  });
});

describe("auto-budget", () => {
  const months = (vals: number[]) => vals.map((spend, i) => ({ month: `2026-0${i + 1}`, spend }));

  it("averages the trailing months and rounds up to a friendly number", () => {
    const [s] = suggestBudgets(new Map([["Groceries", months([600, 640, 610])]]), { basis: 3, excludeOutliers: false });
    expect(s.average).toBeCloseTo(616.67);
    expect(s.suggested).toBe(620);
  });

  it("can ignore one spike month", () => {
    const data = new Map([["Home", months([200, 1800, 220])]]);
    const withSpike = suggestBudgets(data, { basis: 3, excludeOutliers: false })[0];
    const without = suggestBudgets(data, { basis: 3, excludeOutliers: true })[0];
    expect(withSpike.suggested).toBe(740);
    expect(without).toMatchObject({ suggested: 210, excludedMonth: "2026-02" });
  });

  it("uses the last 6 months when asked", () => {
    const [s] = suggestBudgets(new Map([["Gas", months([100, 100, 100, 200, 200, 200, 200])]]), { basis: 6, excludeOutliers: false });
    expect(s.months).toHaveLength(6);
    expect(s.average).toBeCloseTo(166.67);
  });

  it("warns at 80% and flags at 100%", () => {
    expect(budgetStatus(79, 100)).toBe("ok");
    expect(budgetStatus(80, 100)).toBe("warning");
    expect(budgetStatus(100, 100)).toBe("over");
    expect(findSpike([100, 120])).toBeNull();
    expect(friendlyRound(1234)).toBe(1250);
  });
});
