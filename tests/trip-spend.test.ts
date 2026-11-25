import { describe, expect, it } from "vitest";
import { autoLinks, placeKeys, providerKey, suggestForTrip, tripSpendSummary, type SpendStep, type SpendTrip, type SpendTxn } from "@/modules/trips/spend";

const trip: SpendTrip = { id: "trip-1", startDate: "2026-12-26", endDate: "2026-12-30", budget: null, places: ["Pocono Mountains, PA", "Kalahari Resort, Pocono Manor"] };

const step = (p: Partial<SpendStep> & { id: string }): SpendStep => ({
  kind: "lodging",
  title: p.id,
  provider: null,
  cost: null,
  bookingStatus: "booked",
  startsAt: new Date("2026-12-26T20:00:00Z"),
  chargeDate: null,
  ...p,
});

const steps = [
  step({ id: "hotel", title: "Kalahari, 4 nights", provider: "Kalahari Resorts", cost: 1600 }),
  step({ id: "car", kind: "drive", title: "Rental car", provider: "Hertz", cost: 300 }),
  step({ id: "dinner", kind: "meal", title: "Dinner", provider: null, cost: 120, bookingStatus: "idea" }),
];

let n = 0;
const tx = (date: string, amount: number, merchant: string, category: string | null = null, subcategory: string | null = null, description = merchant): SpendTxn => ({
  id: `t${n++}`,
  date,
  merchant,
  description,
  amount,
  category,
  subcategory,
  link: null,
});

describe("matching keys", () => {
  it("takes the distinctive word of a company or place", () => {
    expect(providerKey("Hampton Inn by Hilton")).toBe("hampton");
    expect(providerKey("American Airlines")).toBe("american");
    expect(providerKey("The Grand Hyatt")).toBe("hyatt");
    expect(providerKey(null)).toBeNull();
    expect(placeKeys(["Pocono Mountains, PA", "Lake Placid"])).toEqual(["pocono", "placid"]);
  });
});

describe("suggestForTrip", () => {
  it("matches bookings by company and cost, places during the trip, and leaves home spending out", () => {
    const deposit = tx("2026-09-01", -1590, "KALAHARI POCONOS", "Travel", "Hotel");
    const hertzOther = tx("2026-06-01", -80, "HERTZ RENT A CAR", "Travel", "Rental Car & Taxi");
    const coffee = tx("2026-12-27", -9.5, "WAWA 812", "Food & Dining", null, "WAWA 812 POCONO MANOR PA");
    const gas = tx("2026-12-26", -55, "SUNOCO", "Auto & Transport", "Gas & Fuel");
    const netflix = tx("2026-12-28", -15.99, "NETFLIX", "Entertainment", "Streaming");
    const electric = tx("2026-12-28", -140, "PPL ELECTRIC", "Bills & Utilities");
    const flight = tx("2026-10-10", -450, "UNITED", "Travel", "Air Travel");
    const refund = tx("2027-01-02", 50, "KALAHARI RESORT", "Travel");
    const longAgo = tx("2025-06-01", -200, "KALAHARI POCONOS", "Travel", "Hotel");

    const got = new Map(suggestForTrip(trip, steps, [deposit, hertzOther, coffee, gas, netflix, electric, flight, refund, longAgo]).map((s) => [s.transactionId, s]));

    expect(got.get(deposit.id)).toMatchObject({ confidence: "strong", stepId: "hotel" });
    expect(got.get(hertzOther.id)).toMatchObject({ confidence: "possible", stepId: "car" });
    expect(got.get(coffee.id)).toMatchObject({ confidence: "strong", stepId: null });
    expect(got.get(gas.id)).toMatchObject({ confidence: "possible" });
    expect(got.get(netflix.id)?.confidence).toBe("possible"); // entertainment during the trip: asked, not assumed
    expect(got.has(electric.id)).toBe(false);
    expect(got.get(flight.id)).toMatchObject({ confidence: "possible", stepId: null });
    expect(got.get(refund.id)).toMatchObject({ confidence: "strong", stepId: "hotel" });
    expect(got.has(longAgo.id)).toBe(false);
  });

  it("skips charges already on a trip or dismissed for this one", () => {
    const a = { ...tx("2026-12-27", -30, "POCONO DINER"), link: { targetId: "other", detailId: null, status: "linked" as const } };
    const b = { ...tx("2026-12-27", -30, "POCONO DINER"), link: { targetId: "trip-1", detailId: null, status: "dismissed" as const } };
    const c = { ...tx("2026-12-27", -30, "POCONO DINER"), link: { targetId: "other", detailId: null, status: "dismissed" as const } };
    expect(suggestForTrip(trip, steps, [a, b, c]).map((s) => s.transactionId)).toEqual([c.id]);
  });
});

describe("autoLinks", () => {
  it("links only strong matches, and not ones two trips both claim", () => {
    const overlap: SpendTrip = { ...trip, id: "trip-2", places: ["Pocono Pines"] };
    const deposit = tx("2026-09-01", -1590, "KALAHARI POCONOS", "Travel", "Hotel");
    const diner = tx("2026-12-27", -30, "POCONO DINER");
    const gas = tx("2026-12-26", -55, "SUNOCO", "Auto & Transport", "Gas & Fuel");
    const links = autoLinks(
      [
        { trip, steps },
        { trip: overlap, steps: [] },
      ],
      [deposit, diner, gas],
    );
    expect(links).toEqual([{ transactionId: deposit.id, targetId: "trip-1", detailId: "hotel" }]);
  });
});

describe("tripSpendSummary", () => {
  it("compares plan and actual and flags missing charges, missing bookings and price changes", () => {
    const linked = (t: SpendTxn, detailId: string | null) => ({ ...t, account: "Card", link: { targetId: "trip-1", detailId, status: "linked" as const } });
    const charges = [
      linked(tx("2026-09-01", -1800, "KALAHARI POCONOS", "Travel", "Hotel"), "hotel"),
      linked(tx("2026-12-28", -130, "TROUT CREEK", "Food & Dining", "Restaurants"), "dinner"),
      linked(tx("2026-10-02", -380, "DELTA AIR", "Travel", "Air Travel"), null),
      linked(tx("2026-12-27", -20, "WAWA", "Food & Dining"), null),
    ];
    const s = tripSpendSummary(trip, steps, charges, "2026-12-31");
    expect(s.planned).toBe(2020);
    expect(s.spent).toBe(2330);
    expect(s.remaining).toBe(-310);
    expect(s.spentBeforeTrip).toBe(2180);
    expect(s.byCategory[0]).toEqual({ category: "Travel", amount: 2180 });
    const kinds = s.flags.map((f) => f.kind).sort();
    expect(kinds).toEqual(["charge_without_step", "charged_not_booked", "cost_differs", "no_charge", "over_plan"]);
    expect(s.flags.find((f) => f.kind === "no_charge")?.message).toContain("Rental car");
    expect(s.flags.find((f) => f.kind === "charge_without_step")?.message).toContain("DELTA AIR");
    expect(s.steps.find((x) => x.id === "hotel")).toMatchObject({ planned: 1600, actual: 1800 });
  });

  it("does not ask for charges before the trip when no charge date has passed", () => {
    const s = tripSpendSummary(trip, steps, [], "2026-12-01");
    expect(s.flags.filter((f) => f.kind === "no_charge")).toEqual([]);
    expect(s.spent).toBe(0);
  });
});
