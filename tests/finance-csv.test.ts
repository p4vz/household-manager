import { describe, expect, it } from "vitest";
import { assignExternalIds, parseAmount, parseDate, parseSimplifiCsv, splitCategory } from "@/modules/finance/ingest/csv";
import { looksLikeTransfer, normalizeMerchant } from "@/modules/finance/ingest/merchant";
import { isSyncSlot } from "@/modules/finance/ingest/schedule";

export const SAMPLE_CSV = `account,state,postedOn,payee,usage,category,tags,notes,amount
Chase Sapphire,cleared,2024-03-02,Whole Foods,,Food & Dining: Groceries,,,-84.12
Chase Sapphire,cleared,2024-03-02,Whole Foods,,Food & Dining: Groceries,,,-84.12
Chase Sapphire,cleared,3/5/2024,Shell,,Auto & Transport: Gas,,,"-$45.00"
Joint Checking,cleared,2024-03-01,Payroll,,Income: Paycheck,,,"3,200.00"
Joint Checking,cleared,2024-03-03,Payment Thank You,,Transfer,,,-500.00
Joint Checking,cleared,not-a-date,Broken,,,,,-1
`;

describe("Simplifi CSV parsing", () => {
  it("reads rows, categories and amounts", () => {
    const { rows, skipped } = parseSimplifiCsv(SAMPLE_CSV);
    expect(rows).toHaveLength(5);
    expect(skipped).toEqual([{ line: 7, reason: "unreadable date" }]);
    expect(rows[0]).toMatchObject({
      account: "Chase Sapphire",
      date: "2024-03-02",
      amount: -84.12,
      merchant: "Whole Foods",
      category: "Food & Dining",
      subcategory: "Groceries",
    });
    expect(rows[2]).toMatchObject({ date: "2024-03-05", amount: -45 });
    expect(rows[3].amount).toBe(3200);
    expect(rows[4].isTransfer).toBe(true);
  });
  it("rejects files without the required columns", () => {
    expect(() => parseSimplifiCsv("foo,bar\n1,2\n")).toThrow(/missing required columns/);
  });
  it("gives identical rows distinct but stable ids", () => {
    const { rows } = parseSimplifiCsv(SAMPLE_CSV);
    const a = assignExternalIds(rows);
    const b = assignExternalIds(parseSimplifiCsv(SAMPLE_CSV).rows);
    expect(a[0].externalId).not.toBe(a[1].externalId);
    expect(a.map((r) => r.externalId)).toEqual(b.map((r) => r.externalId));
  });
  it("parses amount and date variants", () => {
    expect(parseAmount("(12.50)")).toBe(-12.5);
    expect(parseAmount("$1,000")).toBe(1000);
    expect(parseAmount("abc")).toBeNull();
    expect(parseDate("02/30/2024")).toBeNull();
    expect(parseDate("1/2/24")).toBe("2024-01-02");
    expect(splitCategory("Uncategorized")).toEqual({ category: null, subcategory: null });
  });
});

describe("merchant cleanup", () => {
  it("strips processor prefixes and store numbers", () => {
    expect(normalizeMerchant("SQ *BLUE BOTTLE COFFEE")).toBe("Blue Bottle Coffee");
    expect(normalizeMerchant("TST* Joe's Pizza")).toBe("Joe's Pizza");
    expect(normalizeMerchant("TARGET #1234 SEATTLE")).toBe("Target");
    expect(normalizeMerchant("PURCHASE AUTHORIZED ON 03/02 SAFEWAY 0123")).toBe("Safeway");
    expect(normalizeMerchant("Netflix.com")).toBe("Netflix.com");
  });
  it("spots transfers and card payments", () => {
    expect(looksLikeTransfer("AUTOPAY PAYMENT THANK YOU")).toBe(true);
    expect(looksLikeTransfer("Trader Joe's")).toBe(false);
  });
});

describe("sync schedule", () => {
  it("fires only at 7 AM and 7 PM household time, across DST", () => {
    // 7 AM in New York is 12:00 UTC in winter and 11:00 UTC in summer.
    expect(isSyncSlot(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe(true);
    expect(isSyncSlot(new Date("2026-07-15T11:00:00Z"), "America/New_York")).toBe(true);
    expect(isSyncSlot(new Date("2026-07-15T12:00:00Z"), "America/New_York")).toBe(false);
    expect(isSyncSlot(new Date("2026-07-15T23:30:00Z"), "America/New_York")).toBe(true);
    const slots = Array.from({ length: 24 }, (_, h) => new Date(Date.UTC(2026, 10, 20, h))).filter((d) =>
      isSyncSlot(d, "America/New_York"),
    );
    expect(slots).toHaveLength(2);
  });
});
