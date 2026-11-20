import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeAccounts, financeTransactions } from "@/core/db/schema";
import type { Db } from "@/core/db/client";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({ runStructured: (...a: unknown[]) => runStructured(...a) }));

const { acceptAllSuggestions, budgetOverview, categorizeUncategorized, dashboardData, drillDownTransactions, setBudget } =
  await import("@/modules/finance/api");

let db: Db;
let me: string;
let joint: string;
beforeEach(async () => {
  db = await freshDb();
  runStructured.mockReset();
  const [a, b] = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Sapphire", owner: "user1", kind: "credit" },
      { bankName: "Joint Checking", owner: "joint", kind: "checking" },
    ])
    .returning();
  me = a.id;
  joint = b.id;
  const txn = (accountId: string, postedDate: string, amount: number, merchant: string, category: string | null, extra = {}) => ({
    accountId,
    source: "csv" as const,
    externalId: `${accountId}-${postedDate}-${merchant}-${amount}`,
    postedDate,
    amount,
    description: merchant,
    merchant,
    category,
    ...extra,
  });
  await db.insert(financeTransactions).values([
    txn(me, "2026-08-03", -300, "Safeway", "Groceries"),
    txn(me, "2026-09-03", -320, "Safeway", "Groceries"),
    txn(me, "2026-10-03", -310, "Safeway", "Groceries"),
    txn(me, "2026-11-03", -260, "Safeway", "Groceries"),
    txn(joint, "2026-11-01", 6000, "Payroll", "Income"),
    txn(joint, "2026-11-05", -1500, "Card payment", null, { isTransfer: true }),
    txn(me, "2026-11-10", -45, "Blue Bottle 1234", null),
    txn(me, "2026-11-11", -15, "Mystery Shop", null),
  ]);
});

const today = new Date("2026-11-20T12:00:00Z");

describe("dashboard data", () => {
  it("excludes transfers and splits income from spending", async () => {
    const data = await dashboardData(today);
    const nov = data.categoryFacts.filter((f) => f.month === "2026-11");
    expect(nov.reduce((s, f) => s + f.spend, 0)).toBe(320);
    expect(nov.reduce((s, f) => s + f.income, 0)).toBe(6000);
  });

  it("drills down into the transactions behind a slice", async () => {
    const rows = await drillDownTransactions({ range: "3M", owner: "user1", accountIds: null, category: "Groceries" }, today);
    expect(rows.map((r) => r.date)).toEqual(["2026-11-03", "2026-10-03", "2026-09-03"]);
    const none = await drillDownTransactions({ range: "3M", owner: "joint", accountIds: null, category: "Groceries" }, today);
    expect(none).toEqual([]);
  });
});

describe("budget", () => {
  it("suggests from complete months and tracks the current month", async () => {
    const o = await budgetOverview(today);
    const groceries = o.rows.find((r) => r.category === "Groceries")!;
    expect(groceries.suggestion).toMatchObject({ suggested: 310 });
    expect(groceries.spent).toBe(260);
    expect(groceries.budget).toBeNull();

    await acceptAllSuggestions(today);
    const after = (await budgetOverview(today)).rows.find((r) => r.category === "Groceries")!;
    expect(after).toMatchObject({ budget: { limit: 310, source: "auto" }, status: "warning" });

    await setBudget("Groceries", 250, "manual");
    await acceptAllSuggestions(today); // manual overrides survive
    const manual = (await budgetOverview(today)).rows.find((r) => r.category === "Groceries")!;
    expect(manual).toMatchObject({ budget: { limit: 250, source: "manual" }, status: "over" });
  });
});

describe("AI categorization", () => {
  it("sends only sanitized merchant data and applies results by id", async () => {
    runStructured.mockImplementation(async ({ payload }) => {
      const merchants = (payload as { merchants: { id: number; merchant: string }[] }).merchants;
      return {
        assignments: merchants
          .map((m) => ({ id: m.id, category: m.merchant.startsWith("Blue") ? "Food & Dining" : "Shopping", subcategory: null }))
          .concat([{ id: 99, category: "Shopping", subcategory: null }]),
      };
    });
    const res = await categorizeUncategorized();
    expect(res.categorized).toBe(2);

    const call = runStructured.mock.calls[0][0];
    expect(call.tier).toBe("fast");
    const sent = JSON.stringify(call.payload);
    expect(sent).not.toMatch(/1234/); // store number scrubbed
    expect(sent).not.toMatch(/Sapphire|Joint Checking|user1|2026-/); // no accounts, owners or dates
    expect(Object.keys(call.payload.merchants[0]).sort()).toEqual(["count", "id", "merchant", "typicalAmount"]);

    const rows = await db.select().from(financeTransactions);
    expect(rows.find((r) => r.merchant === "Blue Bottle 1234")?.category).toBe("Food & Dining");
    expect(rows.find((r) => r.merchant === "Card payment")?.category).toBeNull(); // transfers untouched
  });
});
