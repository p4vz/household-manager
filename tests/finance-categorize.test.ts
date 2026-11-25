import { describe, expect, it } from "vitest";
import {
  buildIndex,
  CONFIDENT,
  coreKey,
  decide,
  type HistoryTxn,
  type Rule,
  type Target,
} from "@/modules/finance/categorize/engine";

const TODAY = "2026-11-20";
let n = 0;
const past = (merchant: string, amount: number, date: string, category: string, subcategory: string | null = null, over: Partial<HistoryTxn> = {}): HistoryTxn => ({
  id: `h${n++}`,
  merchant,
  description: merchant,
  memo: null,
  amount,
  date,
  accountId: "card",
  accountKind: "credit",
  owner: "joint",
  category,
  subcategory,
  source: "import",
  ...over,
});
const target = (merchant: string, amount: number, over: Partial<Target> = {}): Target => ({
  id: "new",
  merchant,
  description: merchant,
  memo: null,
  amount,
  date: TODAY,
  accountId: "card",
  accountKind: "credit",
  owner: "joint",
  pending: false,
  ...over,
});
const index = (history: HistoryTxn[], extra: { rules?: Map<string, Rule>; charges?: HistoryTxn[] } = {}) =>
  buildIndex({
    history,
    charges: [...history, ...(extra.charges ?? [])].map((h) => ({ owner: h.owner, postedDate: h.date, amount: h.amount, merchant: h.merchant })),
    rules: extra.rules ?? new Map(),
    subscriptions: [],
    expected: [],
    today: TODAY,
  });

describe("history-based categorization", () => {
  it("maps the same payee at a similar amount to the category it had before", () => {
    const d = decide(target("Blue Bottle", -6.5), index([past("Blue Bottle", -6, "2026-10-01", "Food & Dining", "Coffee Shops")]));
    expect(d).toMatchObject({ category: "Food & Dining", subcategory: "Coffee Shops" });
    expect(d.confidence).toBeGreaterThanOrEqual(CONFIDENT);
    expect(d.reason).toMatch(/1 past Blue Bottle charge/);
  });

  it("splits a store with two kinds of purchases by amount", () => {
    const history = [
      ...["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"].map((d) => past("Costco", -150, d, "Food & Dining", "Groceries")),
      past("Costco", -1000, "2026-03-01", "Shopping", "Electronics & Software"),
      past("Costco", -1100, "2025-11-28", "Shopping", "Electronics & Software"),
    ];
    const ix = index(history);
    const big = decide(target("Costco", -980), ix);
    expect(big).toMatchObject({ category: "Shopping", subcategory: "Electronics & Software" });
    expect(big.confidence).toBeGreaterThanOrEqual(CONFIDENT);
    expect(decide(target("Costco", -140), ix)).toMatchObject({ category: "Food & Dining", subcategory: "Groceries" });
  });

  it("matches merchants spelled differently", () => {
    expect(coreKey("AMZN Mktp US")).toBe("amazon");
    expect(coreKey("Amazon.com")).toBe("amazon");
    const d = decide(target("AMZN Mktp US", -30), index([past("Amazon.com", -25, "2026-11-01", "Shopping", "General Merchandise"), past("Amazon.com", -35, "2026-10-01", "Shopping", "General Merchandise")]));
    expect(d.category).toBe("Shopping");
    expect(d.reason).toMatch(/similar merchants/);
  });

  it("uses description and memo words to pick between categories at one merchant", () => {
    const history = [
      past("Target", -40, "2026-10-01", "Kids", "Toys", { description: "TARGET toys" }),
      past("Target", -40, "2026-10-02", "Home", "Home Supplies", { description: "TARGET household" }),
    ];
    expect(decide(target("Target", -40, { description: "TARGET toys" }), index(history)).subcategory).toBe("Toys");
  });

  it("sends a steady repeating charge with no history to subscriptions", () => {
    const charges = ["2026-08-05", "2026-09-05", "2026-10-05"].map((d) => ({ ...past("Notion Labs", -10, d, "x"), category: null }));
    const d = decide(target("Notion Labs", -10), index([], { charges }));
    expect(d).toMatchObject({ category: "Bills & Utilities", subcategory: "Subscriptions & Software", recurring: "monthly" });
    expect(d.confidence).toBeGreaterThanOrEqual(CONFIDENT);
  });

  it("keeps its history for a repeating charge that has one, and leaves recurring insurance to Claude", () => {
    const gym = ["2026-08-05", "2026-09-05", "2026-10-05"].map((d) => past("Orange Club", -50, d, "Health & Fitness", "Gym & Fitness"));
    expect(decide(target("Orange Club", -50), index(gym))).toMatchObject({ category: "Health & Fitness", recurring: "monthly" });

    const charges = ["2026-08-05", "2026-09-05", "2026-10-05"].map((d) => ({ ...past("Acme Mutual Insurance", -120, d, "x"), category: null }));
    const ins = decide(target("Acme Mutual Insurance", -120), index([], { charges }));
    expect(ins.confidence).toBeLessThan(CONFIDENT);
  });

  it("lets a rule a person set win over history", () => {
    const history = [past("Shell", -40, "2026-10-01", "Auto & Transport", "Gas & Fuel")];
    const rules = new Map<string, Rule>([["shell", { category: "Business", subcategory: null, source: "manual" }]]);
    expect(decide(target("Shell", -40), index(history, { rules })).category).toBe("Business");
  });

  it("does not apply word hints alone and ignores untrusted history when asked", () => {
    const d = decide(target("Joe's Pizza", -30), index([]));
    expect(d.category).toBe("Food & Dining");
    expect(d.confidence).toBeLessThan(CONFIDENT);

    const guessed = [past("Blue Bottle", -6, "2026-10-01", "Shopping", null, { source: "ai" })];
    expect(decide(target("Blue Bottle", -6), index(guessed), { trustedOnly: true }).category).toBeNull();
  });

  it("files a refund where the purchase went", () => {
    const d = decide(target("REI", 80), index([past("REI", -80, "2026-10-01", "Shopping", "Sporting Goods"), past("REI", -120, "2026-09-01", "Shopping", "Sporting Goods")]));
    expect(d.category).toBe("Shopping");
  });
});
