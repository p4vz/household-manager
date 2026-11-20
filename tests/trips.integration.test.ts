import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeAccounts, financeTransactions } from "@/core/db/schema";
import type { Db } from "@/core/db/client";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({ runStructured: (...a: unknown[]) => runStructured(...a) }));
// No network in tests: place lookups and forecasts return nothing.
vi.mock("@/core/net/outbound", () => ({ outboundFetch: async () => new Response("{}", { status: 404 }) }));

const finance = await import("@/modules/finance/api");
const trips = await import("@/modules/trips/api");
const { registerModules } = await import("@/modules/registry");

let db: Db;
let sapphire: string;
let venture: string;
const NOW = new Date("2026-11-20T12:00:00Z");

beforeEach(async () => {
  db = await freshDb();
  registerModules();
  runStructured.mockReset();
  vi.stubEnv("GEMINI_API_KEY", "test");
  vi.stubEnv("DOC_VAULT_KEY", Buffer.alloc(32, 7).toString("base64"));
  const rows = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Sapphire", displayName: "Sapphire", owner: "user1", kind: "credit" },
      { bankName: "Venture", displayName: "Venture", owner: "user2", kind: "credit" },
    ])
    .returning();
  [sapphire, venture] = rows.map((r) => r.id);
  await finance.saveCardProfile(sapphire, { rewardType: "points", baseRate: 1, centsPerUnit: 1.5, annualFee: 95, annualFeeMonth: null });
  await finance.addCardRule(sapphire, { matchType: "category", match: "Travel", rate: 3, capAmount: null, capPeriod: null, validFrom: null, validTo: null, label: null });
  await finance.saveCardProfile(venture, {
    rewardType: "points",
    baseRate: 2,
    centsPerUnit: 1,
    annualFee: 95,
    annualFeeMonth: null,
    signupBonus: 75_000,
    signupMinSpend: 4000,
    signupStart: "2026-10-20",
    signupDeadline: "2027-01-15",
  });
  // $1,000 already spent on the new card, plus a refund and a payment that must not count.
  await db.insert(financeTransactions).values([
    { accountId: venture, source: "csv", externalId: "a", postedDate: "2026-11-01", amount: -1100, description: "Groceries", merchant: "Whole Foods", category: "Food & Dining" },
    { accountId: venture, source: "csv", externalId: "b", postedDate: "2026-11-03", amount: 100, description: "Refund", merchant: "Whole Foods", category: "Food & Dining" },
    { accountId: venture, source: "csv", externalId: "c", postedDate: "2026-11-05", amount: 1000, description: "Payment", merchant: "Payment", category: "Transfer", isTransfer: true },
  ]);
});

async function newTrip() {
  const { id, slug } = await trips.createTrip({ name: "Thanksgiving Alps", startDate: "2027-11-20", endDate: "2027-11-30", places: ["Zurich"], budget: null });
  const at = (s: string) => new Date(s);
  const base = { destinationId: null, endsAt: null, timezone: "America/New_York", endTimezone: null, location: null, confirmation: null, notes: null, bookingUrl: null, bookingOpensOn: null, gfVetted: false };
  await trips.addItineraryItem(id, { ...base, kind: "flight", title: "PHL to ZRH", startsAt: at("2027-11-20T23:35:00Z"), provider: "United", cost: 2400 });
  await trips.addItineraryItem(id, { ...base, kind: "lodging", title: "Hotel Innsbruck", startsAt: at("2027-11-22T15:00:00Z"), provider: "Marriott", cost: 1800 });
  await trips.addItineraryItem(id, { ...base, kind: "note", title: "Buy Swiss vignette", startsAt: at("2027-11-21T10:00:00Z"), provider: null, cost: null });
  return { id, slug };
}

describe("trips module", () => {
  it("creates a trip with a unique slug and reports step costs to finance and the calendar", async () => {
    const { id, slug } = await newTrip();
    expect(slug).toBe("thanksgiving-alps");
    expect((await trips.createTrip({ name: "Thanksgiving Alps", startDate: "2028-11-20", endDate: "2028-11-25", places: [], budget: null })).slug).toBe("thanksgiving-alps-2");

    const expected = await finance.listExpectedExpenses("2027-01-01");
    expect(expected).toContainEqual(expect.objectContaining({ title: "Trip: Thanksgiving Alps", amount: 4200, category: "Travel", sourceModule: "trips" }));

    await trips.updateTrip(id, { name: "Thanksgiving Alps", startDate: "2027-11-20", endDate: "2027-11-30", budget: 6000, notes: null });
    expect((await finance.listExpectedExpenses("2027-01-01")).find((e) => e.title === "Trip: Thanksgiving Alps")!.amount).toBe(6000);
  });

  it("recommends routing trip bookings to the card with an open sign-up bonus", async () => {
    const { id } = await newTrip();
    const plan = await trips.tripCardPlan(id, NOW);
    const venturePlan = plan.bonuses.find((b) => b.card === "Venture")!;
    // $1,100 - $100 refund = $1,000 spent; payments do not count.
    expect(venturePlan).toMatchObject({ spent: 1000, remaining: 3000, metWithPlan: true, bonusValue: 750 });
    const steps = plan.steps.filter((s) => s.plan);
    expect(steps).toHaveLength(2);
    // $3,000 needed: the hotel ($1,800) alone is not enough, so both go to Venture.
    expect(steps.every((s) => s.plan!.recommended.card === "Venture" && s.plan!.reason === "bonus")).toBe(true);
  });

  it("stops planning a step once it is paid for", async () => {
    const { id } = await newTrip();
    const items = await trips.listItinerary(id);
    const flight = items.find((i) => i.kind === "flight")!;
    await trips.updateBooking(
      flight.id,
      { bookingStatus: "booked", confirmation: "ABC123", provider: "United", bookingUrl: null, seatNote: null, verifyBy: null, cost: 2400, paidWithAccountId: sapphire, chargeDate: "2026-11-20" },
      "user1",
    );
    const plan = await trips.tripCardPlan(id, NOW);
    expect(plan.steps.find((s) => s.id === flight.id)).toMatchObject({ paidWith: "Sapphire", plan: null });
    // The hotel alone cannot reach Venture's minimum, so it goes to the 3x travel card.
    expect(plan.steps.find((s) => s.kind === "lodging")!.plan).toMatchObject({ reason: "multiplier", recommended: { card: "Sapphire" } });
  });

  it("rejects a paid-with account that is not a household credit card", async () => {
    const { id } = await newTrip();
    const [item] = await trips.listItinerary(id);
    await expect(
      trips.updateBooking(item.id, { bookingStatus: "booked", confirmation: null, provider: null, bookingUrl: null, seatNote: null, verifyBy: null, cost: 1, paidWithAccountId: "00000000-0000-4000-8000-000000000000", chargeDate: null }, "user1"),
    ).rejects.toThrow(/Card not found/);
  });

  it("encrypts documents at rest and decrypts them on request", async () => {
    await trips.addDocument(
      { title: "Passport", kind: "passport", tripId: null, travelerId: null, itineraryItemId: null, documentNumber: "X1234 5678", expiresOn: "2027-03-01", issuingCountry: "US", notes: null, file: { name: "p.pdf", type: "application/pdf", bytes: Buffer.from("%PDF secret") } },
      "user1",
    );
    const [doc] = await trips.listDocuments();
    expect(doc).toMatchObject({ documentNumberLast4: "5678", hasFile: true });
    expect(doc).not.toHaveProperty("cipherText");
    const raw = await db.execute<{ cipher_text: Buffer }>("select cipher_text from trips_documents");
    expect(Buffer.from((raw as unknown as { rows: { cipher_text: Uint8Array }[] }).rows[0].cipher_text).toString()).not.toContain("secret");
    const opened = await trips.openDocument(doc.id);
    expect(Buffer.from(opened.base64, "base64").toString()).toBe("%PDF secret");
    expect(await trips.expiringDocuments("2027-06-01")).toHaveLength(1);
  });

  it("refuses file uploads without a vault key", async () => {
    vi.stubEnv("DOC_VAULT_KEY", "");
    await expect(
      trips.addDocument({ title: "x", kind: "other", tripId: null, travelerId: null, itineraryItemId: null, documentNumber: null, expiresOn: null, issuingCountry: null, notes: null, file: { name: "a", type: "", bytes: Buffer.from("a") } }, "user1"),
    ).rejects.toThrow(/DOC_VAULT_KEY/);
  });

  it("clones packing templates per traveller", async () => {
    const { id } = await newTrip();
    await trips.addTraveler({ name: "Kid", kind: "child", birthdate: "2018-05-01", owner: null });
    await trips.addTraveler({ name: "Parent", kind: "adult", birthdate: null, owner: "user1" });
    const people = await trips.listTravelers();
    await trips.createTemplate({ name: "Winter", description: null, tags: [] });
    const [tpl] = await trips.listTemplates();
    await trips.addTemplateItem(tpl.id, { name: "Gloves", category: "clothing", quantity: 1, perPerson: true });
    await trips.addTemplateItem(tpl.id, { name: "First-aid kit", category: "medical", quantity: 1, perPerson: false });
    await trips.applyTemplateToTrip(id, tpl.id, people.map((p) => p.id));
    const [list] = await trips.tripPacking(id);
    expect(list.items.map((i) => i.name).sort()).toEqual(["First-aid kit", "Gloves", "Gloves"]);
  });

  it("scores quizzes on the server and never sends traveller names to the AI", async () => {
    const { slug } = await newTrip();
    const trip = (await trips.getTrip(slug))!;
    const dest = trip.destinations[0];
    await trips.addTraveler({ name: "Danya", kind: "child", birthdate: "2018-05-01", owner: null });
    const [kid] = await trips.listTravelers();

    runStructured.mockResolvedValueOnce({ facts: [{ text: "Zurich has over 1,200 fountains.", category: "general", kidFriendly: true }] });
    await trips.generateTriviaFor(dest.id);
    runStructured.mockResolvedValueOnce({
      title: "Zurich quiz",
      questions: [
        { prompt: "How many fountains?", choices: ["12", "1,200", "5"], answerIndex: 1, explanation: "Lots." },
        { prompt: "Broken", choices: ["a"], answerIndex: 3, explanation: "" },
      ],
    });
    await trips.generateQuizFor(dest.id, 8);
    const { quizzes } = await trips.kidsForTrip(trip.id);
    expect(quizzes[0].questions).toHaveLength(1);
    expect(quizzes[0].questions[0]).not.toHaveProperty("answerIndex");
    const result = await trips.recordQuizAttempt(quizzes[0].id, kid.id, { [quizzes[0].questions[0].id]: 1 });
    expect(result).toMatchObject({ score: 10, total: 10 });

    runStructured.mockResolvedValueOnce({ items: [{ name: "Toaster bags", category: "gf_food", quantity: 1, perPerson: false, reason: "coeliac" }] });
    await trips.createEmptyList(trip.id, "Packing");
    const [packing] = await trips.tripPacking(trip.id);
    await trips.suggestForList(packing.id);
    const sent = JSON.stringify(runStructured.mock.calls.map((c) => c[0].payload));
    expect(sent).not.toContain("Danya");
    expect(sent).toContain("child, age 9");
  });

  it("writes allergy cards for coeliac travellers and resets verification on regeneration", async () => {
    const { slug } = await newTrip();
    const trip = (await trips.getTrip(slug))!;
    await trips.updateDestination(trip.destinations[0].id, { arriveOn: null, departOn: null, languages: ["de"] });
    await trips.addTraveler({ name: "Parent", kind: "adult", birthdate: null, owner: "user2" });
    const [p] = await trips.listTravelers();
    await trips.saveDietProfile(p.id, { celiac: true, glutenFree: true, crossContactStrict: true, otherAllergens: [], dietNotes: null });
    runStructured.mockResolvedValue({ cards: [{ language: "de", languageName: "German", body: "Ich habe Zöliakie.", englishBody: "I have coeliac disease." }] });
    await trips.generateCardsForDestination(trip.destinations[0].id);
    let [{ card }] = await trips.allergyCardsForTrip(trip.id);
    await trips.toggleCardVerified(card.id);
    await trips.generateCardsForDestination(trip.destinations[0].id);
    [{ card }] = await trips.allergyCardsForTrip(trip.id);
    expect(card.verified).toBe(false);
    expect(runStructured.mock.calls[0][0]).toMatchObject({ tier: "flagship", payload: { celiac: true, crossContactStrict: true } });
  });
});
