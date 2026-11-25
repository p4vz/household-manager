import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { financeAccounts, financeCategoryRules, financeTransactions } from "@/core/db/schema";
import type { Db } from "@/core/db/client";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({ runStructured: (...a: unknown[]) => runStructured(...a) }));

const { applyAccountSet } = await import("@/modules/finance/ingest/sync");
const { categorizeTransactions } = await import("@/modules/finance/categorize/run");
const { setMerchantCategory } = await import("@/modules/finance/ai/categorize");
const { learnRules } = await import("@/modules/finance/ingest/categorize");

const now = new Date("2026-11-20T12:00:00Z");
const sec = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;
let db: Db;
let card: string;

beforeEach(async () => {
  db = await freshDb();
  runStructured.mockReset();
  [{ id: card }] = await db.insert(financeAccounts).values({ bankName: "Freedom", simplefinId: "A1", owner: "joint", kind: "credit" }).returning();
  const csv = (externalId: string, postedDate: string, amount: number, merchant: string, category: string, subcategory: string | null) => ({
    accountId: card, source: "csv" as const, externalId, postedDate, amount, description: merchant, merchant, category, subcategory, categorySource: "import" as const,
  });
  await db.insert(financeTransactions).values([
    csv("c1", "2026-05-02", -150, "Costco", "Food & Dining", "Groceries"),
    csv("c2", "2026-06-02", -160, "Costco", "Food & Dining", "Groceries"),
    csv("c3", "2026-07-02", -140, "Costco", "Food & Dining", "Groceries"),
    csv("c4", "2026-03-10", -1200, "Costco", "Shopping", "Electronics & Software"),
    csv("c5", "2025-12-01", -1050, "Costco", "Shopping", "Electronics & Software"),
    csv("c6", "2026-04-01", -30, "Lucky Noodle", "Food & Dining", "Restaurants"),
  ]);
});

const txn = (id: string, date: string, amount: number, payee: string, extra: Record<string, unknown> = {}) => ({
  id, posted: sec(date), amount, description: payee.toUpperCase(), payee, ...extra,
});
const sync = (transactions: ReturnType<typeof txn>[]) =>
  applyAccountSet({
    errors: [],
    accounts: [{ id: "A1", name: "Freedom (...1234)", currency: "USD", balance: -10, "balance-date": now.getTime() / 1000, org: { name: "Chase" }, transactions }],
  });

describe("categorizing synced transactions", () => {
  it("uses amount and history, keeps the memo without account numbers, and records why", async () => {
    await sync([
      txn("t1", "2026-11-01", -155, "Costco", { memo: "Card xxxx 4321 groceries" }),
      txn("t2", "2026-11-02", -1100, "Costco"),
      txn("t3", "2026-11-03", -12, "Brand New Place"),
    ]);
    await categorizeTransactions({ ai: false, now });
    const rows = await db.select().from(financeTransactions).where(eq(financeTransactions.source, "simplefin"));
    const by = (id: string) => rows.find((r) => r.externalId === id)!;
    expect(by("t1")).toMatchObject({ category: "Food & Dining", subcategory: "Groceries", categorySource: "history" });
    expect(by("t1").memo).not.toMatch(/4321/);
    expect(by("t1").categoryReason).toMatch(/past Costco charges/);
    expect(by("t2")).toMatchObject({ category: "Shopping", subcategory: "Electronics & Software" });
    expect(by("t3").category).toBeNull(); // nothing to go on, Claude off
  });

  it("corrects earlier name-only guesses from trusted history but never manual edits", async () => {
    await db.insert(financeTransactions).values([
      { accountId: card, source: "simplefin", externalId: "old1", postedDate: "2026-11-05", amount: -1150, description: "COSTCO", merchant: "Costco", category: "Food & Dining", subcategory: "Groceries", categorySource: "legacy" },
      { accountId: card, source: "simplefin", externalId: "old2", postedDate: "2026-11-06", amount: -30, description: "LUCKY NOODLE", merchant: "Lucky Noodle", category: "Business", subcategory: null, categorySource: "manual" },
    ]);
    const res = await categorizeTransactions({ ai: false, now });
    expect(res.corrected).toBe(1);
    const rows = await db.select().from(financeTransactions).where(eq(financeTransactions.source, "simplefin"));
    expect(rows.find((r) => r.externalId === "old1")).toMatchObject({ category: "Shopping", categorySource: "history" });
    expect(rows.find((r) => r.externalId === "old2")).toMatchObject({ category: "Business", categorySource: "manual" });
  });

  it("keeps manual merchant rules above imported history", async () => {
    await setMerchantCategory("Lucky Noodle", "Business", null);
    await learnRules([{ merchant: "Lucky Noodle", category: "Food & Dining", subcategory: "Restaurants" }]);
    const [rule] = await db.select().from(financeCategoryRules).where(eq(financeCategoryRules.merchant, "lucky noodle"));
    expect(rule).toMatchObject({ category: "Business", source: "manual" });
    await sync([txn("t9", "2026-11-10", -28, "Lucky Noodle")]);
    await categorizeTransactions({ ai: false, now });
    const [row] = await db.select().from(financeTransactions).where(eq(financeTransactions.externalId, "t9"));
    expect(row.category).toBe("Business");
  });
});
