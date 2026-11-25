import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/core/db/client";
import { financeAccounts, financeTransactionLinks, financeTransactions, tripsDestinations, tripsItineraryItems, tripsTrips } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

vi.mock("@/core/net/outbound", () => ({ outboundFetch: async () => new Response("{}", { status: 404 }) }));

const { bus } = await import("@/core/bus");
const { registerModules } = await import("@/modules/registry");
const trips = await import("@/modules/trips/api");
const { listChangesets, recordChangeset, undoChangeset, DraftBook } = await import("@/assistant/changesets");
const { RefBook } = await import("@/assistant/conversations");
const { TOOLS, runTool } = await import("@/assistant/tools");
type Ctx = import("@/assistant/entities").AssistantCtx;

const NOW = new Date("2027-01-05T17:00:00Z");
const ONE: Ctx = { email: "one@example.com", owner: "User 1", viewer: "user1", now: NOW };

let db: Db;
let tripId: string;
let hotelStep: string;
let ids: Record<string, string>;

beforeEach(async () => {
  db = await freshDb();
  registerModules();
  const [mine, joint, hers] = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Sapphire", owner: "user1", kind: "credit" },
      { bankName: "Joint Checking", owner: "joint", kind: "checking" },
      { bankName: "Her Card", owner: "user2", kind: "credit" },
    ])
    .returning();
  const [trip] = await db
    .insert(tripsTrips)
    .values({ name: "Pocono winter", destination: "Pocono Mountains", startDate: "2026-12-26", endDate: "2026-12-30", slug: "pocono-winter" })
    .returning();
  tripId = trip.id;
  await db.insert(tripsDestinations).values({ tripId, name: "Pocono Mountains, PA" });
  const [hotel] = await db
    .insert(tripsItineraryItems)
    .values([
      { tripId, kind: "lodging", title: "Kalahari, 4 nights", provider: "Kalahari Resorts", cost: 1600, bookingStatus: "booked", startsAt: new Date("2026-12-26T20:00:00Z") },
      { tripId, kind: "drive", title: "Rental car", provider: "Hertz", cost: 300, bookingStatus: "booked", startsAt: new Date("2026-12-26T15:00:00Z") },
    ])
    .returning();
  hotelStep = hotel.id;
  let n = 0;
  const txn = (accountId: string, postedDate: string, amount: number, merchant: string, category: string | null, subcategory: string | null = null, description = merchant) => ({
    accountId,
    source: "csv" as const,
    externalId: `x${n++}`,
    postedDate,
    amount,
    merchant,
    description,
    category,
    subcategory,
  });
  const rows = await db
    .insert(financeTransactions)
    .values([
      txn(mine.id, "2026-09-01", -1590, "Kalahari Poconos", "Travel", "Hotel"),
      txn(joint.id, "2026-12-27", -42.5, "Trout Creek Diner", "Food & Dining", "Restaurants", "TROUT CREEK DINER POCONO PINES PA card 4321"),
      txn(mine.id, "2026-12-26", -55, "Sunoco", "Auto & Transport", "Gas & Fuel"),
      txn(hers.id, "2026-12-28", -88, "Pocono Ski Rental", "Travel", null),
      txn(joint.id, "2026-12-28", -140, "PPL Electric", "Bills & Utilities"),
    ])
    .returning();
  ids = { hotel: rows[0].id, diner: rows[1].id, gas: rows[2].id, hers: rows[3].id, electric: rows[4].id };
});

function env(refs = new RefBook({}, 1)) {
  return { ctx: ONE, refs, drafts: new DraftBook() };
}
async function call(name: string, args: unknown, e: ReturnType<typeof env>) {
  const t = TOOLS.find((x) => x.name === name)!;
  return JSON.parse(await runTool(t, args, e));
}

describe("automatic linking", () => {
  it("runs after a bank sync and links only strong matches, private cards included but private to their owner", async () => {
    expect(bus.subscribers("finance.transactionsSynced")).toContain("trips");
    expect(await trips.autoLinkTripCharges(NOW)).toBe(3); // hotel deposit, diner in Pocono Pines, her ski rental in Pocono

    const links = await db.select().from(financeTransactionLinks);
    expect(links.find((l) => l.transactionId === ids.hotel)).toMatchObject({ targetId: tripId, detailId: hotelStep, source: "auto" });
    expect(links.some((l) => l.transactionId === ids.gas)).toBe(false); // only a suggestion

    const pavel = await trips.tripSpend("user1", tripId, NOW);
    expect(pavel.charges.map((c) => c.merchant).sort()).toEqual(["Kalahari Poconos", "Trout Creek Diner"]);
    expect(pavel.spent).toBe(1632.5);
    expect(pavel.suggestions.map((s) => s.merchant)).toEqual(["Sunoco"]);
    expect(pavel.flags.some((f) => f.kind === "no_charge" && f.message.includes("Rental car"))).toBe(true);

    const raisa = await trips.tripSpend("user2", tripId, NOW);
    expect(raisa.charges.map((c) => c.merchant).sort()).toEqual(["Pocono Ski Rental", "Trout Creek Diner"]);

    // Running again changes nothing, and never overrides a person's choice.
    await trips.unlinkTripCharges("user1", [ids.diner]);
    await trips.dismissTripCharges("user1", tripId, [ids.diner]);
    expect(await trips.autoLinkTripCharges(NOW)).toBe(0);
    expect((await trips.tripSpend("user1", tripId, NOW)).suggestions.map((s) => s.merchant)).toEqual(["Sunoco"]);
  });

  it("will not let a member link or unlink the other member's private charges", async () => {
    await expect(trips.linkTripCharges("user1", tripId, [ids.hers])).rejects.toThrow("not found");
    await expect(trips.unlinkTripCharges("user1", [ids.hers])).rejects.toThrow("not found");
  });

  it("counts a step with a linked charge as paid in the card plan", async () => {
    await trips.linkTripCharges("user1", tripId, [ids.hotel], { stepId: hotelStep });
    const plan = await trips.tripCardPlan("user1", tripId, NOW);
    expect(plan.steps.find((s) => s.id === hotelStep)?.paidWith).toBe("Sapphire");
  });
});

describe("Ask Claude", () => {
  it("answers what the trip cost, links suggested charges with undo, and shows no ids or card digits", async () => {
    await trips.autoLinkTripCharges(NOW);
    const e = env();
    const out = await call("trip_spending", { trip: "pocono-winter" }, e);
    const raw = JSON.stringify(out);
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(raw).not.toContain("4321");
    expect(raw).not.toContain("Ski Rental");
    expect(out.spent).toBe(1632.5);
    expect(out.charges.find((c: { merchant: string }) => c.merchant === "Kalahari Poconos").step).toBe("Kalahari, 4 nights");
    const sunoco = out.suggestions[0];
    expect(sunoco).toMatchObject({ merchant: "Sunoco", confidence: "possible" });

    const res = await call("link_trip_charges", { action: "link", refs: [sunoco.ref], trip: "pocono-winter", step: "Rental car" }, e);
    expect(res.queued).toBe(1);
    const id = (await recordChangeset(ONE, null, "add gas", e.drafts.drafts))!;
    let [set] = await listChangesets(ONE, { ids: [id] });
    expect(set.status).toBe("applied");
    expect(set.changes[0].after).toEqual({ trip: "pocono-winter", step: "Rental car", link: "linked" });

    const after = await call("trip_spending", { trip: "pocono-winter" }, env(e.refs));
    expect(after.spent).toBe(1687.5);

    await undoChangeset(ONE, id);
    [set] = await listChangesets(ONE, { ids: [id] });
    expect(set.status).toBe("undone");
    expect((await call("trip_spending", { trip: "pocono-winter" }, env(e.refs))).spent).toBe(1632.5);
  });

  it("refuses an unknown trip or step", async () => {
    const e = env();
    const out = await call("trip_spending", { trip: "pocono-winter" }, e);
    const bad = await call("link_trip_charges", { action: "link", refs: [out.suggestions[0].ref], trip: "pocono-winter", step: "Spa" }, e);
    expect(bad.error).toContain("No itinerary step");
    expect((await call("trip_spending", { trip: "nope" }, e)).error).toContain("No trip");
  });
});
