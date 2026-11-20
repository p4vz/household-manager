import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/core/db/client";
import { financeAccounts, financeTransactions } from "@/core/db/schema";
import { open, seal } from "@/core/secrets/secret-box";
import { commitCsvImport, listAccounts, previewCsvImport } from "@/modules/finance/api";
import { getAccessUrl, storeAccessUrl } from "@/modules/finance/ingest/credentials";
import type { SimplefinAccountSet } from "@/modules/finance/ingest/simplefin";
import { syncSimplefin } from "@/modules/finance/ingest/sync";
import { freshDb } from "./helpers/db";

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;

function bankData(txns: { id: string; date: string; amount: string; desc: string; pending?: boolean }[]): SimplefinAccountSet {
  return {
    errors: ["Connection to Chase may need attention"],
    accounts: [
      {
        id: "ACT-1",
        name: "Sapphire Preferred",
        currency: "USD",
        balance: -1234.56,
        "balance-date": day("2026-11-20"),
        org: { name: "Chase" },
        transactions: txns.map((t) => ({
          id: t.id,
          posted: t.pending ? 0 : day(t.date),
          transacted_at: day(t.date),
          amount: Number(t.amount),
          description: t.desc,
          pending: t.pending,
        })),
      },
    ],
  };
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  vi.stubEnv("AUTH_SECRET", "x".repeat(44));
  vi.stubEnv("SIMPLEFIN_ACCESS_URL", "https://u:p@bridge.simplefin.org/simplefin");
});

describe("SimpleFIN sync", () => {
  it("creates accounts, dedupes by transaction id, and keeps user edits", async () => {
    const data = bankData([
      { id: "T1", date: "2026-11-01", amount: "-12.00", desc: "SQ *BLUE BOTTLE" },
      { id: "T2", date: "2026-11-02", amount: "-40.00", desc: "SHELL OIL 1234" },
    ]);
    const first = await syncSimplefin({ trigger: "setup", now: new Date("2026-11-20T12:00:00Z"), fetcher: async () => data });
    expect(first).toMatchObject({ status: "ok", inserted: 2, accounts: 1 });

    const [acct] = await listAccounts();
    expect(acct).toMatchObject({ bankName: "Sapphire Preferred", institution: "Chase", kind: "credit" });
    await db.update(financeAccounts).set({ displayName: "Alex's Sapphire", owner: "user1" }).where(eq(financeAccounts.id, acct.id));

    // Too soon: refused without calling the bank.
    const fetcher = vi.fn(async () => data);
    expect(await syncSimplefin({ trigger: "cron", now: new Date("2026-11-20T14:00:00Z"), fetcher })).toMatchObject({ status: "skipped" });
    expect(fetcher).not.toHaveBeenCalled();

    const second = await syncSimplefin({ trigger: "cron", now: new Date("2026-11-21T00:00:00Z"), fetcher });
    expect(second).toMatchObject({ status: "ok", inserted: 0 });
    const [after] = await listAccounts();
    expect(after).toMatchObject({ displayName: "Alex's Sapphire", owner: "user1" });
    expect(await db.select().from(financeTransactions)).toHaveLength(2);
  });

  it("drops a pending transaction that reappears under a new id", async () => {
    await syncSimplefin({
      trigger: "setup",
      now: new Date("2026-11-20T12:00:00Z"),
      fetcher: async () => bankData([{ id: "P1", date: "2026-11-19", amount: "-9.99", desc: "NETFLIX", pending: true }]),
    });
    await syncSimplefin({
      trigger: "cron",
      now: new Date("2026-11-21T00:00:00Z"),
      fetcher: async () => bankData([{ id: "F1", date: "2026-11-19", amount: "-9.99", desc: "NETFLIX" }]),
    });
    const rows = await db.select().from(financeTransactions);
    expect(rows.map((r) => r.externalId)).toEqual(["F1"]);
  });
});

const CSV = `account,state,postedOn,payee,category,amount
Chase Sapphire,cleared,2026-07-01,Whole Foods,Food & Dining: Groceries,-80.00
Chase Sapphire,cleared,2026-08-01,Blue Bottle,Food & Dining: Coffee Shops,-6.00
Chase Sapphire,cleared,2026-11-01,Blue Bottle,Food & Dining: Coffee Shops,-12.00
Old Savings,cleared,2020-01-01,Interest,Income: Interest,1.23
`;

describe("Simplifi CSV import", () => {
  it("imports history only before the SimpleFIN start date, and re-imports are no-ops", async () => {
    await syncSimplefin({
      trigger: "setup",
      now: new Date("2026-11-20T12:00:00Z"),
      fetcher: async () => bankData([{ id: "T1", date: "2026-09-01", amount: "-12.00", desc: "BLUE BOTTLE" }]),
    });
    const preview = await previewCsvImport(CSV);
    expect(preview.accounts.map((a) => [a.name, a.rows])).toEqual([
      ["Chase Sapphire", 3],
      ["Old Savings", 1],
    ]);
    const [sapphire] = await listAccounts();

    const mapping = { "Chase Sapphire": sapphire.id, "Old Savings": "new" };
    const result = await commitCsvImport(CSV, mapping);
    expect(result).toMatchObject({ inserted: 3, coveredBySimplefin: 1, alreadyPresent: 0 });

    const again = await commitCsvImport(CSV, { "Chase Sapphire": sapphire.id, "Old Savings": "skip" });
    expect(again).toMatchObject({ inserted: 0, alreadyPresent: 2 });

    // Category rules learned from history now apply to synced rows.
    await syncSimplefin({
      trigger: "cron",
      now: new Date("2026-11-21T12:00:00Z"),
      fetcher: async () => bankData([{ id: "T9", date: "2026-11-21", amount: "-5.00", desc: "BLUE BOTTLE" }]),
    });
    const [t9] = await db.select().from(financeTransactions).where(eq(financeTransactions.externalId, "T9"));
    expect(t9).toMatchObject({ category: "Food & Dining", subcategory: "Coffee Shops" });
  });

  it("removes CSV rows that a later SimpleFIN link covers", async () => {
    const preview = await previewCsvImport(CSV);
    expect(preview.accounts[0].suggestedAccountId).toBeNull();
    await commitCsvImport(CSV, { "Chase Sapphire": "new", "Old Savings": "skip" });
    const [csvAcct] = await listAccounts();
    // Simulate linking: the user maps SimpleFIN onto the CSV account.
    await db.update(financeAccounts).set({ simplefinId: "ACT-1" }).where(eq(financeAccounts.id, csvAcct.id));
    await syncSimplefin({
      trigger: "setup",
      now: new Date("2026-11-20T12:00:00Z"),
      fetcher: async () => bankData([{ id: "T1", date: "2026-08-01", amount: "-6.00", desc: "BLUE BOTTLE" }]),
    });
    const rows = await db.select().from(financeTransactions);
    expect(rows.map((r) => `${r.source}:${r.postedDate}`).sort()).toEqual(["csv:2026-07-01", "simplefin:2026-08-01"]);
  });
});

describe("SimpleFIN credentials", () => {
  it("are stored encrypted and read back", async () => {
    vi.stubEnv("SIMPLEFIN_ACCESS_URL", "");
    await storeAccessUrl("https://user:secret@bridge.simplefin.org/simplefin");
    expect(await getAccessUrl()).toBe("https://user:secret@bridge.simplefin.org/simplefin");
    const sealed = seal("hello");
    expect(sealed).not.toContain("hello");
    expect(open(sealed)).toBe("hello");
    expect(() => open(sealed.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toThrow();
  });
});
