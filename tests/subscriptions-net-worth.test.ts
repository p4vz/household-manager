import { describe, expect, it } from "vitest";
import { detectRecurring, monthlyCost, nextChargeDate } from "@/modules/finance/subscriptions-detect";
import { balanceAt, computeNetWorth, historyDates, itemValueAt } from "@/modules/finance/net-worth-compute";

const t = (postedDate: string, amount: number, merchant: string, owner: "joint" | "user1" | "user2" = "joint") => ({ owner, postedDate, amount, merchant });

describe("detectRecurring", () => {
  it("finds a monthly subscription, its price rise and the next charge", () => {
    const txns = [
      t("2026-07-15", -15.49, "Netflix"),
      t("2026-08-15", -15.49, "Netflix"),
      t("2026-09-15", -15.49, "Netflix"),
      t("2026-10-15", -17.99, "Netflix"),
      t("2026-11-15", -17.99, "Netflix"),
    ];
    const [s] = detectRecurring(txns, "2026-11-25");
    expect(s).toMatchObject({ merchantKey: "netflix", cadence: "monthly", count: 5, lastAmount: 17.99, active: true });
    expect(s.priceChange).toEqual({ from: 15.49, to: 17.99, on: "2026-10-15" });
    expect(nextChargeDate(s.lastDate, s.cadence, "2026-11-25")).toBe("2026-12-15");
  });

  it("finds yearly charges with two payments and keeps owners apart", () => {
    const txns = [t("2025-03-02", -139, "Amazon Prime", "user1"), t("2026-03-03", -139, "Amazon Prime", "user1"), t("2026-03-03", -139, "Amazon Prime", "joint")];
    const found = detectRecurring(txns, "2026-11-25");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ owner: "user1", cadence: "yearly", active: true, priceChange: null });
    expect(monthlyCost(139, "yearly")).toBeCloseTo(11.58, 2);
  });

  it("ignores irregular shopping, swinging bills, refunds and too few charges", () => {
    const txns = [
      t("2026-09-01", -40, "Whole Foods"),
      t("2026-09-04", -120, "Whole Foods"),
      t("2026-09-20", -80, "Whole Foods"),
      t("2026-10-02", -60, "Whole Foods"),
      t("2026-08-10", -90, "PECO"),
      t("2026-09-10", -310, "PECO"),
      t("2026-10-10", -95, "PECO"),
      t("2026-11-10", -280, "PECO"),
      t("2026-10-01", 2500, "Payroll"),
      t("2026-11-01", 2500, "Payroll"),
      t("2026-12-01", 2500, "Payroll"),
      t("2026-10-05", -9.99, "Spotify"),
      t("2026-11-05", -9.99, "Spotify"),
    ];
    expect(detectRecurring(txns, "2026-11-25")).toEqual([]);
  });

  it("marks one that stopped charging as not active", () => {
    const txns = [t("2026-01-05", -12, "Hulu"), t("2026-02-05", -12, "Hulu"), t("2026-03-05", -12, "Hulu")];
    expect(detectRecurring(txns, "2026-11-25")[0].active).toBe(false);
  });

  it("rolls month ends sensibly", () => {
    expect(nextChargeDate("2026-01-31", "monthly", "2026-02-01")).toBe("2026-02-28");
    expect(nextChargeDate("2026-11-20", "weekly", "2026-11-25")).toBe("2026-11-27");
  });
});

describe("net worth", () => {
  const card = { id: "c", owner: "joint" as const, kind: "credit" as const, name: "Card", balance: -500, balanceOn: "2026-11-25" };
  const checking = { id: "k", owner: "joint" as const, kind: "checking" as const, name: "Checking", balance: 4000, balanceOn: "2026-11-25" };
  const mine = { id: "m", owner: "user1" as const, kind: "savings" as const, name: "My savings", balance: 1000, balanceOn: "2026-11-25" };

  it("works past balances back from transactions, preferring a later snapshot", () => {
    const txns = [
      { accountId: "k", date: "2026-11-05", amount: 3000 },
      { accountId: "k", date: "2026-10-20", amount: -200 },
    ];
    expect(balanceAt(checking, "2026-10-31", [], txns, "2026-10-20")).toBe(1000);
    // A snapshot on Nov 3 says 1500 (interest or a market move the feed didn't show).
    expect(balanceAt(checking, "2026-10-31", [{ accountId: "k", date: "2026-11-03", balance: 1500 }], txns, "2026-10-20")).toBe(1500);
    expect(balanceAt(checking, "2026-09-30", [], txns, "2026-10-20")).toBeNull();
  });

  it("values hand-entered items by date and counts liabilities against", () => {
    const house = { id: "h", owner: "joint" as const, kind: "home" as const, name: "House", acquiredOn: "2020-06-01", closedOn: null };
    const values = [
      { itemId: "h", asOf: "2026-01-01", value: 500000 },
      { itemId: "h", asOf: "2026-10-01", value: 520000 },
    ];
    expect(itemValueAt(house, "2025-05-01", values)).toBe(500000);
    expect(itemValueAt(house, "2026-11-01", values)).toBe(520000);
    expect(itemValueAt(house, "2019-01-01", values)).toBeNull();

    const mortgage = { id: "g", owner: "joint" as const, kind: "mortgage" as const, name: "Mortgage", acquiredOn: null, closedOn: null };
    const nw = computeNetWorth({
      owners: ["joint"],
      accounts: [card, checking, mine],
      snapshots: [],
      txns: [],
      items: [house, mortgage],
      values: [...values, { itemId: "g", asOf: "2026-11-01", value: 300000 }],
      today: "2026-11-25",
      months: 3,
    });
    expect(nw.total).toBe(4000 - 500 + 520000 - 300000);
    expect(nw.liabilities).toBe(-300500);
    expect(nw.lines.some((l) => l.name === "My savings")).toBe(false);
    expect(nw.history.at(-1)).toEqual({ date: "2026-11-25", total: nw.total });
  });

  it("lists month ends then today", () => {
    expect(historyDates("2026-11-25", 3)).toEqual(["2026-08-31", "2026-09-30", "2026-10-31", "2026-11-25"]);
  });
});
