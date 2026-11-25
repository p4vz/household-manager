import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/core/db/client";
import { financeAccountImages, financeAccounts, financeCardProfiles, financeTransactions } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
const runVisionStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({
  runStructured: (...a: unknown[]) => runStructured(...a),
  runVisionStructured: (...a: unknown[]) => runVisionStructured(...a),
  runWebResearch: vi.fn(async () => {
    throw new Error("no web in tests");
  }),
}));

const api = await import("@/modules/finance/api");
const { extractLast4 } = await import("@/modules/finance/ingest/redact");
const { applyAccountSet } = await import("@/modules/finance/ingest/sync");
const { assistantAccounts } = await import("@/modules/finance/assistant");
const { resetSeedFlagForTests } = await import("@/modules/finance/rewards/catalog/store");

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("card-front-without-number")]);
const today = new Date("2026-11-20T12:00:00Z");
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  resetSeedFlagForTests();
  runStructured.mockReset();
  runVisionStructured.mockReset();
  vi.stubEnv("DOC_VAULT_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("GEMINI_API_KEY", "test-key");
});

const identified = (over: Partial<Record<string, unknown>> = {}) => ({
  isPaymentCard: true,
  numberVisible: false,
  issuer: "Chase",
  product: "Sapphire Preferred",
  business: false,
  issuerDomain: "chase.com",
  catalogId: "chase-sapphire-preferred",
  confidence: "high",
  ...over,
});

describe("last 4 digits", () => {
  it("are read from the bank's name, kept apart from it, and shown only to members who can see the account", async () => {
    expect(extractLast4("Freedom Unlimited (...1234)")).toBe("1234");
    expect(extractLast4("CHECKING xxxx-5678")).toBe("5678");
    expect(extractLast4("Visa 4111 1111 1111 9999")).toBe("9999");
    expect(extractLast4("Amex Gold")).toBeNull();

    await applyAccountSet(
      {
        errors: [],
        accounts: [{ id: "A1", name: "Freedom Unlimited (...1234)", currency: "USD", balance: -5, "balance-date": today.getTime() / 1000, org: { name: "Chase" }, transactions: [] }],
      },
      "user1",
    );
    const [row] = await db.select().from(financeAccounts);
    expect(row).toMatchObject({ bankName: "Freedom Unlimited", last4: "1234", owner: "user1" });

    expect((await api.listAccounts("user1"))[0].last4).toBe("1234");
    expect((await api.listAccounts("user2"))[0].last4).toBeNull();
    expect(await api.visibleAccountLast4("user1")).toEqual({ [row.id]: "1234" });
    expect(await api.visibleAccountLast4("user2")).toEqual({});
  });

  it("can be typed on the Accounts page, four digits only", async () => {
    const [a] = await db.insert(financeAccounts).values({ bankName: "Gold", owner: "user1", kind: "credit" }).returning();
    const patch = { displayName: null, officialName: null, owner: "user1" as const, kind: "credit" as const, active: true };
    await api.updateAccount("user1", a.id, { ...patch, last4: "4321" });
    expect((await api.listAccounts("user1"))[0].last4).toBe("4321");
    await expect(api.updateAccount("user1", a.id, { ...patch, last4: "43210" })).rejects.toThrow(/four digits/);
  });

  it("never reach the AI advisor, the in-app assistant's account list or shared card lists", async () => {
    const [a] = await db.insert(financeAccounts).values({ bankName: "Gold", owner: "user1", kind: "credit", last4: "4321" }).returning();
    await db.insert(financeTransactions).values({
      accountId: a.id, source: "csv", externalId: "t1", postedDate: "2026-11-02", amount: -40, description: "Cafe", merchant: "Cafe", category: "Dining",
    });
    await api.saveCardProfile("user1", a.id, { rewardType: "points", baseRate: 1, centsPerUnit: 1, annualFee: 250, annualFeeMonth: null });
    runStructured.mockResolvedValue({ summary: "ok", underperformingCards: [], billIncreases: [], signupBonusIdeas: [] });
    await api.runAdvisorNow("user1");
    expect(JSON.stringify(runStructured.mock.calls[0][0])).not.toContain("4321");
    expect(JSON.stringify(await assistantAccounts("user1"))).not.toContain("4321");
    expect(JSON.stringify(await api.listCardsWithProfiles("user1"))).not.toContain("4321");
    expect(JSON.stringify(await api.listRecentTransactions("user1"))).not.toContain("4321");
    expect(JSON.stringify(await api.heldCardTerms("user1"))).not.toContain("4321");
  });
});

describe("adding a card from a photo", () => {
  it("identifies the card, links it to the catalog, keeps the photo and shows benefits", async () => {
    runVisionStructured.mockResolvedValue(identified());
    const r = await api.addCardFromPhoto("user1", { owner: "user1", image: jpeg, nickname: "Travel", last4: "7777" });
    expect(r).toMatchObject({ product: "Chase Sapphire Preferred", productId: "chase-sapphire-preferred", hasTerms: true });

    // The model got the picture and the catalog list, never the last 4 digits or the nickname.
    const call = runVisionStructured.mock.calls[0][0];
    expect(call.image.data.equals(jpeg)).toBe(true);
    expect(JSON.stringify(call.payload)).not.toMatch(/7777|Travel/);

    const acct = (await api.listAccounts("user1")).find((a) => a.id === r.accountId)!;
    expect(acct).toMatchObject({ displayName: "Travel", last4: "7777", kind: "credit", officialName: "Chase Sapphire Preferred", catalogProductId: "chase-sapphire-preferred", linked: false });
    expect(acct.image).toMatch(/^data:image\/jpeg;base64,/);
    const [profile] = await db.select().from(financeCardProfiles).where(eq(financeCardProfiles.accountId, r.accountId));
    expect(profile.annualFee).toBeGreaterThan(0);
    expect((await api.listCardsWithProfiles("user1")).map((c) => c.accountId)).toContain(r.accountId);
  });

  it("adds an unknown card to the catalog for lookup", async () => {
    runVisionStructured.mockResolvedValue(identified({ issuer: "Example Bank", product: "Rocket Rewards", business: true, issuerDomain: "https://www.examplebank.com/cards", catalogId: null }));
    const r = await api.addCardFromPhoto("user2", { owner: "joint", image: jpeg, nickname: null, last4: null });
    expect(r).toMatchObject({ product: "Example Bank Rocket Rewards", hasTerms: false });
    const entry = (await api.cardCatalog()).find((p) => p.id === r.productId)!;
    expect(entry.sourceDomains).toEqual(["examplebank.com"]);
    expect((await api.listAccounts("user1")).find((a) => a.id === r.accountId)).toMatchObject({ kind: "business_credit", owner: "joint" });
  });

  it("refuses photos where the number can be read, and stores nothing", async () => {
    runVisionStructured.mockResolvedValue(identified({ numberVisible: true }));
    await expect(api.addCardFromPhoto("user1", { owner: "user1", image: jpeg, nickname: null, last4: null })).rejects.toThrow(/number can be read/);
    runVisionStructured.mockResolvedValue(identified({ isPaymentCard: false }));
    await expect(api.addCardFromPhoto("user1", { owner: "user1", image: jpeg, nickname: null, last4: null })).rejects.toThrow(/doesn't look like/);
    expect(await db.select().from(financeAccounts)).toEqual([]);
    expect(await db.select().from(financeAccountImages)).toEqual([]);
  });

  it("only adds cards for yourself or as joint", async () => {
    await expect(api.addCardFromPhoto("user1", { owner: "user2", image: jpeg, nickname: null, last4: null })).rejects.toThrow(/yourself or as joint/);
    expect(runVisionStructured).not.toHaveBeenCalled();
  });

  it("joins the bank-synced account later by its last 4 digits", async () => {
    runVisionStructured.mockResolvedValue(identified());
    const r = await api.addCardFromPhoto("user1", { owner: "user1", image: jpeg, nickname: "Travel", last4: "7777" });
    await applyAccountSet(
      {
        errors: [],
        accounts: [{ id: "SF-9", name: "Sapphire Preferred (...7777)", currency: "USD", balance: -1, "balance-date": today.getTime() / 1000, org: { name: "Chase" }, transactions: [] }],
      },
      "user1",
    );
    const rows = await db.select().from(financeAccounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.accountId, simplefinId: "SF-9", displayName: "Travel" });
  });
});
