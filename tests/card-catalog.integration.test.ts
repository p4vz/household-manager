import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeAccounts, financeCardCatalog, financeCardRules, financeTransactions } from "@/core/db/schema";
import type { Db } from "@/core/db/client";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
const runWebResearch = vi.fn();
vi.mock("@/core/ai/run", () => ({
  runStructured: (...a: unknown[]) => runStructured(...a),
  runWebResearch: (...a: unknown[]) => runWebResearch(...a),
}));

const api = await import("@/modules/finance/api");
const { resetSeedFlagForTests } = await import("@/modules/finance/rewards/catalog/store");
const { CATALOG_SEED } = await import("@/modules/finance/rewards/catalog/seed");
const { registerModules } = await import("@/modules/registry");

const flexSeed = CATALOG_SEED.find((s) => s.id === "chase-freedom-flex")!;
const NOW = new Date("2026-11-20T11:00:00Z"); // 6 AM in New York

let db: Db;
let flex: string;
let other: string;

beforeEach(async () => {
  db = await freshDb();
  resetSeedFlagForTests();
  registerModules();
  vi.stubEnv("HOUSEHOLD_TIMEZONE", "America/New_York");
  vi.stubEnv("GEMINI_API_KEY", "test");
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "Alexandra Smith");
  runWebResearch.mockReset();
  runStructured.mockReset();
  const rows = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Freedom Flex ****9876", displayName: "Alexandra's Flex", owner: "user1", kind: "credit" },
      { bankName: "Other card", owner: "user2", kind: "credit" },
    ])
    .returning();
  [flex, other] = rows.map((r) => r.id);
  await db.insert(financeTransactions).values([
    { accountId: flex, source: "csv", externalId: "a", postedDate: "2026-11-02", amount: -100, description: "Shell", merchant: "Shell", category: "Auto & Transport", subcategory: "Gas & Fuel" },
    { accountId: flex, source: "csv", externalId: "b", postedDate: "2026-11-03", amount: -50, description: "Pizza", merchant: "Pizza Place", category: "Food & Dining", subcategory: "Restaurants" },
    { accountId: other, source: "csv", externalId: "c", postedDate: "2026-10-10", amount: -400, description: "Groceries", merchant: "Kroger", category: "Food & Dining", subcategory: "Groceries" },
  ]);
});

/** What the AI lookup returns: the seed terms with `patch`, sourced from chase.com. */
function lookupReturns(patch: Partial<typeof flexSeed.terms>, sources: { url: string; title: string | null }[] = [{ url: "https://creditcards.chase.com/freedom/flex", title: null }]) {
  runWebResearch.mockResolvedValue({
    output: { found: true, terms: { ...flexSeed.terms, ...patch }, sourceUrls: [], caveats: null },
    notes: "notes",
    sources,
  });
}

const q4 = { program: "Chase Freedom 5%", rate: 5, capAmount: 1500, activationRequired: true, quarters: [{ quarter: "2026-Q4", on: ["gas"], description: "Gas stations" }] };
const offer = { bonus: 200, minSpend: 500, windowMonths: 3, extras: null, endDate: null };

describe("card catalog", () => {
  it("seeds well-known cards once and never overwrites existing rows", async () => {
    const first = await api.cardCatalog();
    expect(first.length).toBe(CATALOG_SEED.length);
    expect(first.every((p) => p.status === "seed" && p.terms)).toBe(true);
    await db.update(financeCardCatalog).set({ name: "Renamed" }).where(eq(financeCardCatalog.id, "chase-freedom-flex"));
    resetSeedFlagForTests();
    expect((await api.cardCatalog()).find((p) => p.id === "chase-freedom-flex")!.name).toBe("Renamed");
  });

  it("links a card, applies catalog rules beside the user's own, and feeds rotating quarters into the audit", async () => {
    await api.cardCatalog();
    await api.linkCardToCatalog("user1", flex, "chase-freedom-flex");
    await api.addCardRule("user1", flex, { matchType: "merchant", match: "Pizza Place", rate: 10, capAmount: null, capPeriod: null, validFrom: null, validTo: null, label: "my promo" });

    let cards = await api.listCardsWithProfiles("user1");
    const card = cards.find((c) => c.accountId === flex)!;
    expect(card.profile).toMatchObject({ annualFee: 0, baseRate: 1, catalogProductId: "chase-freedom-flex" });
    expect(card.rules.filter((r) => r.source === "catalog").length).toBeGreaterThan(0);

    // The refresh learns Q4's rotating category and a new sign-up offer.
    lookupReturns({ rotating: q4, signupOffer: offer });
    expect(await api.runCatalogRefreshIfDue(NOW)).toMatchObject({ status: "ok" });
    const product = (await api.cardCatalog()).find((p) => p.id === "chase-freedom-flex")!;
    expect(product).toMatchObject({ status: "verified", held: true, version: 2 });
    expect(product.terms!.signupOffer).toEqual(offer);

    // The search sent only public card names, nothing about the household.
    const sent = JSON.stringify(runWebResearch.mock.calls.map((c) => c[0].payload));
    expect(sent).not.toMatch(/Alexandra|9876|Kroger|Shell/);
    expect(runWebResearch.mock.calls[0][0].allowedDomains).toEqual(["chase.com"]);

    // Audit: $100 gas at the 5% rotating rate, pizza at the user's own 10x.
    const { audit } = await api.rewardsAudit("user1", "12M", NOW);
    const flexPerf = audit!.perCard.find((c) => c.card === "Alexandra's Flex")!;
    expect(flexPerf.earned).toBeCloseTo(5 + 5);

    // The card's stored rules were not touched; a drift notice is shown instead.
    const drift = await api.catalogDriftForCards("user1");
    expect(drift).toEqual([expect.objectContaining({ accountId: flex, version: 2, appliedVersion: 1 })]);
    expect(drift[0].changes.map((c) => c.field)).toEqual(expect.arrayContaining(["rotating", "signupOffer"]));
    await api.keepCardRules("user1", flex);
    expect(await api.catalogDriftForCards("user1")).toEqual([]);

    // Re-applying replaces only catalog rules.
    await api.applyCatalogTermsToCard("user1", flex);
    cards = await api.listCardsWithProfiles("user1");
    expect(cards.find((c) => c.accountId === flex)!.rules.filter((r) => r.source === "user").map((r) => r.label)).toEqual(["my promo"]);
  });

  it("holds changes to user-edited terms, and large changes, for review", async () => {
    await api.cardCatalog();
    await api.saveCatalogTermsByUser("chase-freedom-flex", { ...flexSeed.terms, perks: ["mine"] });
    lookupReturns({ perks: ["from issuer"] });
    const r = await api.refreshCatalogCardNow("chase-freedom-flex");
    expect(r.status).toBe("pending");
    const [pending] = await api.listCatalogChanges({ status: "pending" });
    expect(pending.reason).toMatch(/You edited/);
    expect((await api.cardCatalog()).find((p) => p.id === "chase-freedom-flex")!.terms!.perks).toEqual(["mine"]);

    await api.acceptCatalogChange(pending.id);
    expect((await api.cardCatalog()).find((p) => p.id === "chase-freedom-flex")!.terms!.perks).toEqual(["from issuer"]);

    lookupReturns({ annualFee: 550 });
    expect((await api.refreshCatalogCardNow("chase-freedom-flex")).status).toBe("pending");
  });

  it("refuses answers without an issuer source", async () => {
    await api.cardCatalog();
    lookupReturns({ annualFee: 0, perks: [] }, [{ url: "https://some-blog.example/flex", title: "some-blog.example" }]);
    const r = await api.refreshCatalogCardNow("chase-freedom-flex");
    expect(r).toMatchObject({ status: "error" });
    const p = (await api.cardCatalog()).find((x) => x.id === "chase-freedom-flex")!;
    expect(p.status).toBe("seed");
    expect(p.lastError).toMatch(/chase\.com/);
  });

  it("runs only in the 6 AM slot and caps cards per run", async () => {
    lookupReturns({});
    expect(await api.runCatalogRefreshIfDue(new Date("2026-11-20T15:00:00Z"))).toMatchObject({ status: "skipped" });
    const res = await api.runCatalogRefreshIfDue(NOW);
    expect(res).toMatchObject({ status: "ok", checked: 6 });
  });

  it("gives the advisor stored terms and priced candidate cards", async () => {
    await api.cardCatalog();
    await api.linkCardToCatalog("user1", flex, "chase-freedom-flex");
    await db.update(financeCardCatalog).set({ terms: { ...flexSeed.terms, rotating: q4 } }).where(eq(financeCardCatalog.id, "chase-freedom-flex"));
    runStructured.mockResolvedValue({ summary: "ok", underperformingCards: [], billIncreases: [], signupBonusIdeas: [] });
    await api.runAdvisorNow("user1");
    const payload = runStructured.mock.calls[0][0].payload;
    const flexCard = payload.cards.find((c: { catalogTerms: unknown }) => c.catalogTerms);
    expect(flexCard.catalogTerms).toMatchObject({ product: "Chase Freedom Flex", verifiedDate: "not yet verified" });
    expect(payload.candidateCards.length).toBe(8);
    expect(payload.candidateCards.map((c: { card: string }) => c.card)).not.toContain("Chase Freedom Flex");
    expect(JSON.stringify(payload)).not.toMatch(/Alexandra|9876/);
  });

  it("removing a catalog card unlinks it without deleting the household card's rules", async () => {
    await api.cardCatalog();
    await api.linkCardToCatalog("user1", flex, "chase-freedom-flex");
    const before = await db.select().from(financeCardRules).where(eq(financeCardRules.accountId, flex));
    await db.delete(financeCardCatalog).where(eq(financeCardCatalog.id, "chase-freedom-flex"));
    const after = await db.select().from(financeCardRules).where(eq(financeCardRules.accountId, flex));
    expect(after.length).toBe(before.length);
    expect((await api.listCardsWithProfiles("user1")).find((c) => c.accountId === flex)!.profile!.catalogProductId).toBeNull();
  });
});
