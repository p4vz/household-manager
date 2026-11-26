import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/core/db/client";
import { calendarEvents, financeAccounts, financeCategoryRules, financeTransactions } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({ runStructured: (...a: unknown[]) => runStructured(...a), runWebResearch: vi.fn() }));
vi.mock("@/core/net/outbound", () => ({ outboundFetch: async () => new Response("{}", { status: 404 }) }));

const finance = await import("@/modules/finance/api");
const maintenance = await import("@/modules/maintenance/api");
const { registerModules } = await import("@/modules/registry");
const { answerLargePurchase } = await import("@/assistant/review");
const { listChangesets, undoChangeset } = await import("@/assistant/changesets");
const { contextFor } = await import("@/assistant/service");

const NOW = new Date("2026-11-25T17:00:00Z");
const PAVEL = { email: "one@example.com", owner: "User 1" as const };

let db: Db;
let linked: string, imported: string, joint: string, hers: string;
let n = 0;
const txn = (accountId: string, source: "csv" | "simplefin", postedDate: string, amount: number, merchant: string, category: string | null = null, subcategory: string | null = null) => ({
  accountId,
  source,
  externalId: `x${n++}`,
  postedDate,
  amount,
  merchant,
  description: merchant,
  category,
  subcategory,
});

beforeEach(async () => {
  db = await freshDb();
  registerModules();
  runStructured.mockReset();
  vi.stubEnv("HOUSEHOLD_TIMEZONE", "America/New_York");
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "Pat Example");
  const [a, b, c, d] = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Chase Freedom Unlimited", simplefinId: "ACT-1", owner: "user1", kind: "credit", simplefinStartDate: "2026-09-01", balance: -100, balanceDate: NOW },
      { bankName: "Freedom Unlimited (Imported)", owner: "user1", kind: "other" },
      { bankName: "JOINT CHECKING", simplefinId: "ACT-2", owner: "joint", kind: "checking", balance: 5000, balanceDate: new Date("2026-11-01T00:00:00Z") },
      { bankName: "Her Card", owner: "user2", kind: "credit" },
    ])
    .returning();
  [linked, imported, joint, hers] = [a.id, b.id, c.id, d.id];
  await db.insert(financeTransactions).values([
    txn(linked, "simplefin", "2026-09-03", -42.5, "Shell"),
    txn(linked, "simplefin", "2026-10-05", -12, "Cafe"),
    // The import: older history plus two rows the bank feed also has.
    txn(imported, "csv", "2026-06-10", -60, "Shell", "Gas & Fuel"),
    txn(imported, "csv", "2026-09-02", -42.5, "SHELL OIL", "Gas & Fuel"),
    txn(imported, "csv", "2026-10-04", -12, "CAFE", "Coffee Shops"),
    txn(joint, "csv", "2026-05-01", -8400, "Comfort Air Heating", null),
    txn(joint, "simplefin", "2026-10-01", -2100, "Mortgage Co", "Home", "Mortgage & Rent"),
    txn(joint, "csv", "2026-04-01", -30, "Hockey Club", "Hockey Club"),
    txn(joint, "csv", "2026-04-02", -45, "Cinema", "Amusement"),
    txn(hers, "csv", "2026-05-02", -900, "Jewelry Store", "Amusement"),
  ]);
  await db.insert(financeCategoryRules).values({ merchant: "cinema", category: "Amusement", subcategory: null });
});

describe("finance review: reconcile", () => {
  it("offers the imported account for merging and flags names, balances and gaps", async () => {
    const r = await finance.reconcileReport("user1", NOW);
    expect(r.imported).toHaveLength(1);
    expect(r.imported[0]).toMatchObject({ accountId: imported, suggestedIntoId: linked, count: 3 });
    // Raisa's personal account is not part of Pavel's review.
    expect(JSON.stringify(r)).not.toContain("Her Card");
    expect(r.names.find((x) => x.accountId === imported)).toMatchObject({ suggested: "Freedom Unlimited", suggestedKind: "credit" });
    expect(r.names.find((x) => x.accountId === joint)?.suggested).toBe("Joint Checking");
    expect(r.coverage.some((c) => c.accountId === joint && /Balance last updated 2026-11-01/.test(c.text))).toBe(true);
  });

  it("never offers a bank account's import a credit card to merge into", async () => {
    const [wf] = await db
      .insert(financeAccounts)
      .values({ bankName: "Wells Fargo Joint (Imported)", owner: "joint", kind: "other" })
      .returning();
    const [card] = await db
      .insert(financeAccounts)
      .values({ bankName: "Wells Fargo Active Cash Card", simplefinId: "ACT-3", owner: "joint", kind: "credit", balanceDate: NOW })
      .returning();
    await db.insert(financeTransactions).values([
      txn(wf.id, "csv", "2026-05-01", 2500, "PAYROLL DIRECT DEP"),
      txn(wf.id, "csv", "2026-05-03", -200, "ATM WITHDRAWAL"),
      txn(wf.id, "csv", "2026-05-04", -80, "ZELLE TO FRIEND"),
    ]);
    const r = await finance.reconcileReport("user1", NOW);
    const row = r.imported.find((x) => x.accountId === wf.id)!;
    // Its activity made it a checking account, so no card is listed or suggested.
    expect(row.candidates.map((c) => c.id)).not.toContain(card.id);
    expect(row.candidates.map((c) => c.id)).toContain(joint);
    expect(row.suggestedIntoId).not.toBe(card.id);
    const [typed] = await db.select().from(financeAccounts).where(eq(financeAccounts.id, wf.id));
    expect(typed).toMatchObject({ kind: "checking", kindSource: "guess" });
    await expect(finance.mergeImportedAccount("user1", wf.id, card.id)).rejects.toThrow(/can't be merged/);

    // A type a person saved is never changed by the guesser.
    await finance.updateAccount("user1", wf.id, { displayName: null, officialName: null, last4: null, owner: "joint", kind: "savings", active: true });
    await finance.reconcileReport("user1", NOW);
    const [kept] = await db.select().from(financeAccounts).where(eq(financeAccounts.id, wf.id));
    expect(kept).toMatchObject({ kind: "savings", kindSource: "manual" });
  });

  it("merges the import into the linked account without duplicates, and undoes it", async () => {
    const before = await db.select().from(financeTransactions).where(eq(financeTransactions.accountId, imported));
    const res = await finance.mergeImportedAccount("user1", imported, linked);
    expect(res).toMatchObject({ moved: 1, removed: 2 });
    const into = await db.select().from(financeTransactions).where(eq(financeTransactions.accountId, linked));
    expect(into.map((t) => t.postedDate).sort()).toEqual(["2026-06-10", "2026-09-03", "2026-10-05"]);
    const [acct] = await db.select().from(financeAccounts).where(eq(financeAccounts.id, imported));
    expect(acct.active).toBe(false);
    expect((await finance.reconcileReport("user1", NOW)).duplicates).toEqual([]);

    const [entry] = await finance.listReviewActions("user1");
    await finance.undoReviewAction("user1", entry.id);
    const back = await db.select().from(financeTransactions).where(eq(financeTransactions.accountId, imported));
    expect(back.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort());
    const [again] = await db.select().from(financeAccounts).where(eq(financeAccounts.id, imported));
    expect(again.active).toBe(true);
  });

  it("removes CSV copies the bank feed also has, and can put them back", async () => {
    // Imported straight into the linked account this time.
    await db.update(financeTransactions).set({ accountId: linked }).where(eq(financeTransactions.accountId, imported));
    const dupes = (await finance.reconcileReport("user1", NOW)).duplicates;
    expect(dupes.map((d) => d.csvDate).sort()).toEqual(["2026-09-02", "2026-10-04"]);
    const res = await finance.removeDuplicateCopies("user1", dupes.map((d) => d.csvId));
    expect(res.removed).toBe(2);
    const [entry] = await finance.listReviewActions("user1");
    await finance.undoReviewAction("user1", entry.id);
    expect((await finance.reconcileReport("user1", NOW)).duplicates).toHaveLength(2);
  });

  it("won't touch the other member's accounts", async () => {
    await expect(finance.mergeImportedAccount("user1", hers, linked)).rejects.toThrow(/not available/);
    await expect(finance.renameAccountForReview("user1", hers, "Mine now", "credit")).rejects.toThrow(/not available/);
    await expect(finance.reviewTransaction("user1", (await db.select().from(financeTransactions).where(eq(financeTransactions.accountId, hers)))[0].id)).rejects.toThrow();
  });
});

describe("finance review: categories", () => {
  it("maps history onto the category set, with Claude for the rest, and undoes it", async () => {
    const { rows } = await finance.categoryReview("user1");
    const amusement = rows.find((r) => r.from.category === "Amusement")!;
    expect(amusement).toMatchObject({ source: "built-in", suggestion: { category: "Entertainment", subcategory: "Amusement" } });
    const hockey = rows.find((r) => r.from.category === "Hockey Club")!;
    expect(hockey.suggestion).toBeNull();

    runStructured.mockImplementation(async (opts: { payload: { oldCategories: { id: number; category: string }[] } }) => {
      expect(JSON.stringify(opts.payload)).not.toMatch(/Her Card|Pat Example/);
      return { items: opts.payload.oldCategories.map((c) => ({ id: c.id, category: "Kids", subcategory: c.category === "Hockey Club" ? "Activities" : "Not a real one" })) };
    });
    await finance.proposeCategoriesWithAi("user1", NOW);
    const after = await finance.categoryReview("user1");
    expect(after.rows.find((r) => r.from.category === "Hockey Club")).toMatchObject({ source: "claude", suggestion: { category: "Kids", subcategory: "Activities" } });

    const res = await finance.applyCategoryMapping("user1", [
      { from: amusement.from, to: { category: "Entertainment", subcategory: "Amusement" } },
      { from: hockey.from, to: { category: "Kids", subcategory: "Activities" } },
    ]);
    expect(res.changed).toBe(2);
    const cats = await db.select().from(financeTransactions);
    expect(cats.find((t) => t.merchant === "Cinema")).toMatchObject({ category: "Entertainment", subcategory: "Amusement" });
    // Raisa's transaction in the same old category is hers to remap.
    expect(cats.find((t) => t.merchant === "Jewelry Store")).toMatchObject({ category: "Amusement" });
    const [rule] = await db.select().from(financeCategoryRules).where(eq(financeCategoryRules.merchant, "cinema"));
    expect(rule.category).toBe("Entertainment");

    await expect(finance.applyCategoryMapping("user1", [{ from: { category: "Kids", subcategory: "Activities" }, to: { category: "Made Up", subcategory: null } }])).rejects.toThrow(/isn't in the category set/);

    const [entry] = await finance.listReviewActions("user1");
    await finance.undoReviewAction("user1", entry.id);
    const undone = await db.select().from(financeTransactions);
    expect(undone.find((t) => t.merchant === "Cinema")).toMatchObject({ category: "Amusement", subcategory: null });
    const [ruleBack] = await db.select().from(financeCategoryRules).where(eq(financeCategoryRules.merchant, "cinema"));
    expect(ruleBack.category).toBe("Amusement");
  });
});

describe("finance review: large purchases to house upkeep", () => {
  it("asks about unexplained large purchases only", async () => {
    const t = await finance.largeThreshold("user1");
    expect(t).toBe(500);
    const { open } = await finance.largePurchases("user1", t);
    // The furnace is asked about; the mortgage payment and Raisa's purchase are not.
    expect(open.map((p) => p.merchant)).toEqual(["Comfort Air Heating"]);
    expect(await finance.setLargeThreshold("user1", 10)).toBe(50);
  });

  it("turns an answer into a note, equipment and upkeep, all undoable", async () => {
    const [furnace] = (await finance.largePurchases("user1", 500)).open;
    runStructured.mockImplementation(async (opts: { payload: Record<string, unknown> }) => {
      const sent = JSON.stringify(opts.payload);
      expect(sent).toContain("new furnace");
      expect(sent).not.toMatch(/Pat Example|JOINT CHECKING|Joint Checking/);
      return {
        summary: "Recorded the new furnace and a yearly service.",
        note: "New furnace install",
        houseRelated: true,
        equipment: { name: "Furnace", kind: "hvac", location: "Basement", installedOn: null, notes: null },
        tasks: [
          { title: "HVAC service", firstDueDate: "2027-04-01", repeatEveryDays: 365, estimatedCost: 180, notes: null },
          { title: "Bad date task", firstDueDate: "2020-01-01", repeatEveryDays: null, estimatedCost: null, notes: null },
        ],
      };
    });
    const out = await answerLargePurchase(PAVEL, furnace.id, "That was the new furnace, Pat Example paid", NOW);
    expect(out.summary).toMatch(/furnace/);
    const asset = (await maintenance.listAssets()).find((a) => a.name === "Furnace");
    expect(asset).toMatchObject({ name: "Furnace", kind: "hvac", cost: 8400, installedOn: "2026-05-01" });
    const tasks = await maintenance.listOpenTasks();
    expect(tasks.find((x) => x.title === "HVAC service")).toMatchObject({ recurrenceDays: 365, dueDate: "2027-04-01" });
    // A past due date becomes today.
    expect(tasks.find((x) => x.title === "Bad date task")?.dueDate).toBe("2026-11-25");
    const [row] = await db.select().from(financeTransactions).where(eq(financeTransactions.id, furnace.id));
    expect(row.notes).toBe("New furnace install");
    // Answered: not asked again, and the stored answer has no legal name.
    const after = await finance.largePurchases("user1", 500);
    expect(after.open).toHaveLength(0);
    expect(after.done[0].answer).not.toContain("Pat Example");

    const [set] = await listChangesets(contextFor(PAVEL, NOW));
    expect(set.status).toBe("applied");
    await undoChangeset(contextFor(PAVEL, NOW), out.changesetId!);
    expect((await maintenance.listAssets()).some((a) => a.name === "Furnace")).toBe(false);
    expect((await maintenance.listOpenTasks()).some((x) => x.title === "HVAC service")).toBe(false);
  });

  it("still saves the answer as a note when Claude can't be reached", async () => {
    const [furnace] = (await finance.largePurchases("user1", 500)).open;
    runStructured.mockRejectedValue(new Error("No AI provider configured"));
    const out = await answerLargePurchase(PAVEL, furnace.id, "new furnace", NOW);
    expect(out.summary).toMatch(/Claude couldn't be reached/);
    const [row] = await db.select().from(financeTransactions).where(eq(financeTransactions.id, furnace.id));
    expect(row.notes).toBe("new furnace");
  });

  it("skips a whole merchant", async () => {
    expect(await finance.dismissLargePurchasesAt("user1", "Comfort Air Heating", 500)).toBe(1);
    expect((await finance.largePurchases("user1", 500)).open).toHaveLength(0);
  });
});

describe("house upkeep seed", () => {
  it("has Pavel's maintenance items, equipment and project history after migrations", async () => {
    const tasks = await maintenance.listOpenTasks();
    const filters = tasks.find((t) => t.title === "Replace HVAC air filters");
    expect(filters).toMatchObject({ recurrenceDays: 30, area: "HVAC & heating", dueDate: "2026-12-01" });
    expect(tasks.find((t) => t.title === "Replace RO pre-filters")).toMatchObject({ recurrenceDays: 182, area: "Water filtration" });
    expect(tasks.find((t) => t.title === "Heating tune-up and boiler flush")).toMatchObject({ recurrenceDays: 365, lastDoneOn: "2026-08-28" });
    expect(tasks.find((t) => t.title === "Replace attic AC coil")).toMatchObject({ recurrenceDays: null, estimatedCost: 1500, dueDate: "2027-03-01" });
    expect(tasks.filter((t) => !t.todo)).toHaveLength(11);
    expect(tasks.filter((t) => t.todo)).toHaveLength(3);
    const events = await db.select().from(calendarEvents).where(eq(calendarEvents.sourceRef, filters!.id));
    expect(events.map((e) => e.title)).toEqual(["Maintenance: Replace HVAC air filters"]);
    const expected = await finance.listExpectedExpenses("2026-01-01");
    expect(expected.map((e) => e.title)).toContain("Replace attic AC coil");

    const projects = await maintenance.listProjects();
    expect(projects).toHaveLength(13);
    expect(projects.find((p) => p.title === "PECO gas line relocation")).toMatchObject({ date: "2025-01-29", amount: 3966.74 });
    expect(projects.at(-1)?.period).toMatch(/2022|2023/);
    // No invoice, order or work-order numbers, no individuals' names.
    expect(JSON.stringify(projects)).not.toMatch(/#\d|Work Order|Invoice|Order #|Shawn|Param|Chris/);
    expect((await maintenance.listAssets()).length).toBeGreaterThanOrEqual(10);
  });
});
