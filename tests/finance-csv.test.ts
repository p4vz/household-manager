import { describe, expect, it } from "vitest";
import {
  assignExternalIds,
  parseAmount,
  parseDate,
  parseSimplifiCsv,
  splitCategory,
  summarizeSkipped,
} from "@/modules/finance/ingest/csv";
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
    expect(skipped).toEqual([{ line: 7, reason: "unreadable date", value: "not-a-date" }]);
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
  it("accepts the date shapes spreadsheets and exports produce", () => {
    expect(parseDate("2024-03-02T00:00:00.000Z")).toBe("2024-03-02");
    expect(parseDate("3/2/2024 12:00:00 AM")).toBe("2024-03-02");
    expect(parseDate("2024/03/02")).toBe("2024-03-02");
    expect(parseDate("03-02-2024")).toBe("2024-03-02");
    expect(parseDate("Mar 2, 2024")).toBe("2024-03-02");
    expect(parseDate("2-Mar-24")).toBe("2024-03-02");
    expect(parseDate("20240302")).toBe("2024-03-02");
    expect(parseDate("25/12/2024")).toBe("2024-12-25");
    expect(parseDate("")).toBeNull();
  });
  it("accepts the amount shapes spreadsheets and exports produce", () => {
    expect(parseAmount("−12.34")).toBe(-12.34); // unicode minus
    expect(parseAmount("-$1,234.50")).toBe(-1234.5);
    expect(parseAmount("$-5")).toBe(-5);
    expect(parseAmount("($8.00)")).toBe(-8);
    expect(parseAmount("12.34-")).toBe(-12.34);
    expect(parseAmount("USD 9.99")).toBe(9.99);
    expect(parseAmount("1 234,56")).toBe(1234.56);
    expect(parseAmount("1,234")).toBe(1234);
    expect(parseAmount("+3")).toBe(3);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("-")).toBeNull();
  });
});

describe("Simplifi CSV export variants", () => {
  it("handles a BOM, title lines above the header, quoted commas and footer totals", () => {
    const csv = [
      "\uFEFFTransactions export",
      "All dates",
      "",
      "Account,Date,Payee,Category,Amount,Notes",
      'Card A,1/5/2024 12:00:00 AM,"Joe\'s Pizza, Inc.",Dining,"($1,020.00)",',
      "Card A,Jan 6 2024,Shell,Auto & Transport: Gas,−40.00,",
      ",,,,,",
      "Total,,,,-1060.00,",
    ].join("\r\n");
    const { rows, skipped, columns, headerLine } = parseSimplifiCsv(csv);
    expect(headerLine).toBe(4);
    expect(columns).toMatchObject({ date: "Date", payee: "Payee", amount: "Amount", account: "Account" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2024-01-05", amount: -1020, description: "Joe's Pizza, Inc." });
    expect(rows[1]).toMatchObject({ date: "2024-01-06", amount: -40 });
    expect(skipped).toEqual([{ line: 8, reason: "summary or total line" }]);
  });
  it("reads separate debit and credit columns", () => {
    const csv = "Posted Date,Description,Debit,Credit\n2024-02-01,Grocer,25.10,\n2024-02-02,Refund,,5\n";
    const { rows } = parseSimplifiCsv(csv);
    expect(rows.map((r) => r.amount)).toEqual([-25.1, 5]);
  });
  it("reads tab and semicolon separated files", () => {
    expect(parseSimplifiCsv("date\tpayee\tamount\n2024-02-01\tGrocer\t-3\n").rows).toHaveLength(1);
    expect(parseSimplifiCsv("date;payee;amount\n2024-02-01;Grocer;-3,50\n").rows[0].amount).toBe(-3.5);
  });
  it("explains every skipped line with an example value", () => {
    const csv = "postedOn,payee,amount\n13/45/2024,A,1\n2024-01-01,B,abc\n2024-01-02,,1\n2024-01-03,C,\n";
    const { skipped } = parseSimplifiCsv(csv);
    expect(summarizeSkipped(skipped)).toEqual([
      { reason: "unreadable date", count: 1, lines: [2], examples: ["13/45/2024"] },
      { reason: "unreadable amount", count: 1, lines: [3], examples: ["abc"] },
      { reason: "no payee", count: 1, lines: [4], examples: [] },
      { reason: "no amount", count: 1, lines: [5], examples: [] },
    ]);
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
