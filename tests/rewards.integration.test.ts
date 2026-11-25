import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeAccounts, financeTransactions } from "@/core/db/schema";
import type { Db } from "@/core/db/client";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({ runStructured: (...a: unknown[]) => runStructured(...a) }));

const { addCardRule, latestAdvisorReport, rewardsAudit, runAdvisorNow, saveCardProfile } = await import("@/modules/finance/api");
const { listUpcoming } = await import("@/modules/calendar/api");
const { registerModules } = await import("@/modules/registry");

let db: Db;
let sapphire: string;
let amex: string;
beforeEach(async () => {
  db = await freshDb();
  registerModules();
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "Alexandra Smith");
  const rows = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Sapphire Preferred ****1234", displayName: "Alexandra's Sapphire", owner: "user1", kind: "credit" },
      { bankName: "Amex", owner: "joint", kind: "credit" },
    ])
    .returning();
  [sapphire, amex] = rows.map((r) => r.id);
  const months = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
  await db.insert(financeTransactions).values(
    months.flatMap((m, i) => [
      { accountId: amex, source: "csv" as const, externalId: `d${i}`, postedDate: `${m}-05`, amount: -200, description: "Sushi", merchant: "Sushi Den", category: "Food & Dining" },
      { accountId: amex, source: "csv" as const, externalId: `n${i}`, postedDate: `${m}-10`, amount: i < 4 ? -15.49 : -22.99, description: "Netflix", merchant: "Netflix", category: "Entertainment" },
    ]),
  );
});

describe("rewards + advisor", () => {
  it("audits with saved profiles and puts the annual fee on the calendar", async () => {
    await saveCardProfile("user1", sapphire, { rewardType: "points", baseRate: 1, centsPerUnit: 1.5, annualFee: 95, annualFeeMonth: 3 }, new Date("2026-11-20T00:00:00Z"));
    await saveCardProfile("user1", amex, { rewardType: "cashback", baseRate: 1, centsPerUnit: 1, annualFee: 0, annualFeeMonth: null });
    await addCardRule("user1", sapphire, { matchType: "category", match: "Food & Dining", rate: 3, capAmount: null, capPeriod: null, validFrom: null, validTo: null, label: null });

    const { audit } = await rewardsAudit("user1", "12M", new Date("2026-11-20T00:00:00Z"));
    // 6 dinners x $200: 1% = $12 earned vs 3x * 1.5c = $54 possible ($42 missed),
    // plus Netflix at 1% instead of 1.5% ($107.94 * 0.5% = $0.54).
    expect(audit!.totalMissed).toBeCloseTo(42.54);
    expect(audit!.byCategory[0]).toMatchObject({ category: "Food & Dining", useCard: "Alexandra's Sapphire" });

    const events = await listUpcoming("2026-01-01");
    expect(events).toContainEqual(expect.objectContaining({ title: "Annual fee: Alexandra's Sapphire ($95.00)", startDate: "2027-03-01" }));
  });

  it("sends the advisor only sanitized aggregates and stores the report", async () => {
    await saveCardProfile("user1", sapphire, { rewardType: "points", baseRate: 1, centsPerUnit: 1.5, annualFee: 95, annualFeeMonth: null });
    runStructured.mockResolvedValue({ summary: "ok", underperformingCards: [], billIncreases: [], signupBonusIdeas: [] });
    await runAdvisorNow("user1");

    const call = runStructured.mock.calls[0][0];
    expect(call.tier).toBe("flagship");
    const sent = JSON.stringify(call.payload);
    expect(sent).not.toMatch(/Smith/i);
    expect(sent).not.toMatch(/1234/);
    expect(sent).not.toMatch(/user1|@/);
    expect(sent).toMatch(/"owner":"User 1"/);
    expect(call.payload.recurringMerchants.map((m: { merchant: string }) => m.merchant)).toEqual(
      expect.arrayContaining(["Netflix", "Sushi Den"]),
    );
    expect((await latestAdvisorReport("user1"))?.report.summary).toBe("ok");
  });
});
