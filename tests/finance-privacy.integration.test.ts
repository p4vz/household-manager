import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Db } from "@/core/db/client";
import { financeAccountImages, financeAccounts, financeTransactions } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({ runStructured: (...a: unknown[]) => runStructured(...a) }));

const api = await import("@/modules/finance/api");
const { stripAccountNumbers, cleanTypedName } = await import("@/modules/finance/ingest/redact");
const { guessAccountKind } = await import("@/modules/finance/ingest/merchant");
const { storeAccessUrl } = await import("@/modules/finance/ingest/credentials");
const { syncSimplefin } = await import("@/modules/finance/ingest/sync");

const today = new Date("2026-11-20T12:00:00Z");
let db: Db;
let pavel: string;
let raisa: string;
let joint: string;

beforeEach(async () => {
  db = await freshDb();
  runStructured.mockReset();
  const [a, b, c] = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Sapphire", displayName: "Pavel travel card", owner: "user1", kind: "credit", balance: -500 },
      { bankName: "Amex Gold", displayName: "Raisa dining card", owner: "user2", kind: "credit", balance: -800 },
      { bankName: "Joint Checking", owner: "joint", kind: "checking", balance: 9000 },
    ])
    .returning();
  pavel = a.id;
  raisa = b.id;
  joint = c.id;
  const txn = (accountId: string, postedDate: string, amount: number, merchant: string, category: string | null) => ({
    accountId,
    source: "csv" as const,
    externalId: `${accountId}-${postedDate}-${merchant}`,
    postedDate,
    amount,
    description: merchant,
    merchant,
    category,
  });
  await db.insert(financeTransactions).values([
    txn(pavel, "2026-11-03", -100, "Pavel Bookshop", "Shopping"),
    txn(pavel, "2026-10-03", -100, "Pavel Bookshop", "Shopping"),
    txn(pavel, "2026-09-03", -100, "Pavel Bookshop", "Shopping"),
    txn(pavel, "2026-08-03", -100, "Pavel Bookshop", "Shopping"),
    txn(raisa, "2026-09-04", -70, "Raisa Florist", "Gifts"),
    txn(raisa, "2026-08-04", -70, "Raisa Florist", "Gifts"),
    txn(joint, "2026-09-05", -200, "Safeway", "Groceries"),
    txn(joint, "2026-08-05", -200, "Safeway", "Groceries"),
    txn(raisa, "2026-11-04", -70, "Raisa Florist", "Gifts"),
    txn(raisa, "2026-10-04", -70, "Raisa Florist", "Gifts"),
    txn(joint, "2026-11-05", -200, "Safeway", "Groceries"),
    txn(joint, "2026-10-05", -200, "Safeway", "Groceries"),
    txn(joint, "2026-11-01", 5000, "Payroll", "Income"),
  ]);
});

const merchantsIn = (x: unknown) => JSON.stringify(x);

describe("private accounts in Finance", () => {
  it("each member sees joint data and their own, never the other's", async () => {
    const forPavel = await api.dashboardData("user1", today);
    const forRaisa = await api.dashboardData("user2", today);
    expect(merchantsIn(forPavel)).toContain("Pavel Bookshop");
    expect(merchantsIn(forPavel)).not.toContain("Raisa Florist");
    expect(merchantsIn(forRaisa)).toContain("Raisa Florist");
    expect(merchantsIn(forRaisa)).not.toContain("Pavel Bookshop");
    expect(forRaisa.accounts.map((a) => a.id).sort()).toEqual([raisa, joint].sort());
    expect(new Set(forRaisa.categoryFacts.map((f) => f.accountId))).not.toContain(pavel);

    const txPavel = await api.listRecentTransactions("user1");
    expect(txPavel.map((t) => t.merchant)).not.toContain("Raisa Florist");
    const txRaisa = await api.listRecentTransactions("user2");
    expect(txRaisa.map((t) => t.merchant)).not.toContain("Pavel Bookshop");

    // Asking for the other member's slice returns nothing, even through drill-down.
    const drill = await api.drillDownTransactions("user2", { range: "3M", owner: "user1", accountIds: null }, today);
    expect(drill).toEqual([]);
    const byId = await api.drillDownTransactions("user2", { range: "3M", owner: "all", accountIds: [pavel] }, today);
    expect(byId).toEqual([]);

    const spend = await api.spendingSummary("user2", "3M", "all", today);
    expect(merchantsIn(spend)).not.toContain("Pavel Bookshop");
    const flow = await api.cashFlowSummary("user2", "3M", "all", today);
    expect(flow.series.find((m) => m.month === "2026-11")?.spend).toBe(270);
  });

  it("keeps budgets per member, built from what each can see", async () => {
    const pav = await api.budgetOverview("user1", today);
    const rai = await api.budgetOverview("user2", today);
    expect(pav.rows.map((r) => r.category).sort()).toEqual(["Groceries", "Shopping"]);
    expect(rai.rows.map((r) => r.category).sort()).toEqual(["Gifts", "Groceries"]);
    await api.setBudget("user1", "Groceries", 500, "manual");
    expect((await api.budgetOverview("user2", today)).rows.find((r) => r.category === "Groceries")?.budget).toBeNull();
    await api.acceptAllSuggestions("user2", today);
    expect((await api.budgetOverview("user1", today)).rows.find((r) => r.category === "Groceries")?.budget?.limit).toBe(500);
    await api.removeBudget("user2", "Groceries");
    expect((await api.budgetOverview("user1", today)).rows.find((r) => r.category === "Groceries")?.budget?.limit).toBe(500);
  });

  it("limits rewards, bonuses and the advisor to the member's cards", async () => {
    await api.saveCardProfile("user1", pavel, { rewardType: "points", baseRate: 1, centsPerUnit: 1, annualFee: 0, annualFeeMonth: null });
    await api.saveCardProfile("user2", raisa, {
      rewardType: "points", baseRate: 1, centsPerUnit: 1, annualFee: 0, annualFeeMonth: null,
      signupBonus: 60000, signupMinSpend: 3000, signupStart: "2026-10-01", signupDeadline: "2027-01-31",
    });
    expect((await api.listCardsWithProfiles("user1")).map((c) => c.accountId)).toEqual([pavel]);
    const audit = await api.rewardsAudit("user1", "12M", today);
    expect(audit.cards.map((c) => c.accountId)).toEqual([pavel]);
    expect(await api.signupBonusOverview("user1", today)).toEqual([]);
    expect((await api.signupBonusOverview("user2", today)).length).toBe(1);

    runStructured.mockResolvedValue({ summary: "ok", underperformingCards: [], billIncreases: [], signupBonusIdeas: [] });
    await api.runAdvisorNow("user1");
    const sent = JSON.stringify(runStructured.mock.calls[0][0].payload);
    expect(sent).not.toMatch(/Raisa|Florist|Gifts|Amex/);
    expect(await api.latestAdvisorReport("user1")).not.toBeNull();
    expect(await api.latestAdvisorReport("user2")).toBeNull();
  });

  it("refuses changes to the other member's accounts", async () => {
    const patch = { displayName: "x", officialName: null, owner: "joint" as const, kind: "credit" as const, active: true };
    await expect(api.updateAccount("user2", pavel, patch)).rejects.toThrow(/not available/);
    await expect(api.saveCardProfile("user2", pavel, { rewardType: "points", baseRate: 1, centsPerUnit: 1, annualFee: 0, annualFeeMonth: null })).rejects.toThrow();
    await expect(api.addCardRule("user2", pavel, { matchType: "category", match: "Shopping", rate: 5, capAmount: null, capPeriod: null, validFrom: null, validTo: null, label: null })).rejects.toThrow();
    await expect(api.linkCardToCatalog("user2", pavel, null)).rejects.toThrow();
    await expect(api.setAccountImage("user2", pavel, Buffer.from([0xff, 0xd8, 0xff, 0x00]))).rejects.toThrow();
    // Joint accounts are editable by both; making one personal hides it from the other.
    await api.updateAccount("user2", joint, { ...patch, owner: "user2", kind: "checking" });
    expect(await api.visibleAccountIds("user1")).toEqual(new Set([pavel]));
  });
});

describe("account management page", () => {
  it("lists every account to both members, without the other's balance", async () => {
    const rows = await api.listAccounts("user2");
    expect(rows).toHaveLength(3);
    const p = rows.find((r) => r.id === pavel)!;
    expect(p).toMatchObject({ displayName: "Pavel travel card", owner: "user1", visible: false, canEdit: false, balance: null });
    expect(rows.find((r) => r.id === raisa)).toMatchObject({ visible: true, canEdit: true, balance: -800 });
    expect(rows.every((r) => r.linked === false)).toBe(true);
  });

  it("strips digits from names people type", async () => {
    await api.updateAccount("user1", pavel, {
      displayName: "Travel card 4111 1111 1111 1111",
      officialName: "Chase Sapphire Preferred (...1234)",
      owner: "user1",
      kind: "business_credit",
      active: true,
    });
    const row = (await api.listAccounts("user1")).find((r) => r.id === pavel)!;
    expect(row).toMatchObject({ displayName: "Travel card", officialName: "Chase Sapphire Preferred", kind: "business_credit" });
    // Business credit cards count as cards for rewards.
    expect((await api.listCardsWithProfiles("user1")).map((c) => c.accountId)).toContain(pavel);
  });

  it("stores card pictures encrypted and shows them on the page", async () => {
    vi.stubEnv("DOC_VAULT_KEY", randomBytes(32).toString("base64"));
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("card-front-pixels")]);
    await api.setAccountImage("user1", pavel, jpeg);
    const [stored] = await db.select().from(financeAccountImages);
    expect(stored.cipherText.includes(Buffer.from("card-front-pixels"))).toBe(false);
    const row = (await api.listAccounts("user2")).find((r) => r.id === pavel)!;
    expect(row.image).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`);

    await expect(api.setAccountImage("user1", pavel, Buffer.from("<svg onload=alert(1)>"))).rejects.toThrow(/JPEG, PNG or WebP/);
    await expect(api.setAccountImage("user1", pavel, Buffer.alloc(700 * 1024, 0xff))).rejects.toThrow(/too large/);
    await api.deleteAccountImage("user1", pavel);
    expect(await db.select().from(financeAccountImages)).toEqual([]);
  });

  it("refuses pictures until the vault key is set", async () => {
    vi.stubEnv("DOC_VAULT_KEY", "");
    await expect(api.setAccountImage("user1", pavel, Buffer.from([0xff, 0xd8, 0xff, 0]))).rejects.toThrow(/DOC_VAULT_KEY/);
  });
});

describe("new accounts start private", () => {
  it("bank sync gives new accounts to whoever linked the banks, without numbers in the name", async () => {
    vi.stubEnv("SIMPLEFIN_ACCESS_URL", "");
    vi.stubEnv("AUTH_SECRET", "x".repeat(44));
    await storeAccessUrl("https://user:secret@bridge.simplefin.org/simplefin", "user2");
    await syncSimplefin({
      trigger: "setup",
      now: today,
      fetcher: async () => ({
        errors: [],
        accounts: [
          { id: "NEW-1", name: "Freedom Unlimited (...9876)", currency: "USD", balance: -10, "balance-date": today.getTime() / 1000, org: { name: "Chase" }, transactions: [] },
        ],
      }),
    });
    const [row] = await db.select().from(financeAccounts).where((await import("drizzle-orm")).eq(financeAccounts.simplefinId, "NEW-1"));
    expect(row).toMatchObject({ owner: "user2", bankName: "Freedom Unlimited" });
  });

  it("CSV import only offers the member's visible accounts and creates new ones as theirs", async () => {
    const csv = "Date,Account,Payee,Category,Amount\n2026-01-05,Old Card 5555,Shop,Shopping,-10\n";
    const preview = await api.previewCsvImport("user2", csv);
    expect(preview.existingAccounts.map((a) => a.id).sort()).toEqual([raisa, joint].sort());
    await expect(api.commitCsvImport("user2", csv, { "Old Card 5555": pavel })).rejects.toThrow(/Unknown account/);
    await api.commitCsvImport("user2", csv, { "Old Card 5555": "new" });
    const created = (await api.listAccounts("user1")).find((a) => a.bankName === "Old Card");
    expect(created).toMatchObject({ owner: "user2", visible: false });
  });
});

describe("helpers", () => {
  it("strips account numbers from names", () => {
    expect(stripAccountNumbers("Freedom Unlimited (...1234)")).toBe("Freedom Unlimited");
    expect(stripAccountNumbers("CHECKING xxxx5678")).toBe("CHECKING");
    expect(stripAccountNumbers("Visa 4111-1111-1111-1111")).toBe("Visa");
    expect(stripAccountNumbers("Box Checking 1234")).toBe("Box Checking");
    expect(stripAccountNumbers("Amex Gold")).toBe("Amex Gold");
    expect(stripAccountNumbers("1234")).toBe("Account");
    expect(cleanTypedName("  ")).toBeNull();
  });

  it("guesses business account types", () => {
    expect(guessAccountKind("Ink Business Preferred")).toBe("business_credit");
    expect(guessAccountKind("Business Checking")).toBe("business_checking");
    expect(guessAccountKind("Total Checking")).toBe("checking");
  });
});
