import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/core/db/client";
import { financeAccounts, financeTransactions, maintenanceTasks } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({ runStructured: (...a: unknown[]) => runStructured(...a), runWebResearch: vi.fn(), runVisionStructured: vi.fn() }));
vi.mock("@/core/net/outbound", () => ({ outboundFetch: vi.fn() }));

const maintenance = await import("@/modules/maintenance/api");
const family = await import("@/modules/family/api");
const calendar = await import("@/modules/calendar/api");
const { registerModules } = await import("@/modules/registry");
const { needsAttention, dateTone, dueWords } = await import("@/assistant/attention");
const inbox = await import("@/assistant/inbox");

const NOW = new Date("2026-11-25T17:00:00Z");
const TODAY = "2026-11-25";

let db: Db;
let mine: string, joint: string, hers: string;
const ids: Record<string, string> = {};
let n = 0;

beforeEach(async () => {
  db = await freshDb();
  registerModules();
  runStructured.mockReset();
  vi.stubEnv("HOUSEHOLD_TIMEZONE", "America/New_York");
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "Pat Example");
  const [a, b, c] = await db
    .insert(financeAccounts)
    .values([
      { bankName: "His Card", owner: "user1", kind: "credit" },
      { bankName: "Joint Checking", owner: "joint", kind: "checking" },
      { bankName: "Her Card", owner: "user2", kind: "credit" },
    ])
    .returning();
  [mine, joint, hers] = [a.id, b.id, c.id];
  const rows = [
    ["tv", joint, "2026-11-20", -1200, "Best Buy", "Shopping"],
    ["herBig", hers, "2026-11-21", -900, "Nordstrom", "Shopping"],
    ["target", mine, "2026-11-22", -54.12, "Target", "Shopping"],
    ["herTarget", hers, "2026-11-22", -54.12, "Target", "Shopping"],
  ] as const;
  const inserted = await db
    .insert(financeTransactions)
    .values(
      rows.map(([, accountId, postedDate, amount, merchant, category]) => ({
        accountId,
        source: "csv" as const,
        externalId: `h${n++}`,
        postedDate,
        amount,
        merchant,
        description: merchant,
        category,
      })),
    )
    .returning({ id: financeTransactions.id });
  rows.forEach(([k], i) => (ids[k] = inserted[i].id));
});

describe("needs attention", () => {
  it("dates: overdue, due soon, or not shown", () => {
    expect(dateTone(TODAY, "2026-11-20", 14)).toBe("overdue");
    expect(dateTone(TODAY, "2026-12-01", 14)).toBe("soon");
    expect(dateTone(TODAY, "2027-01-30", 14)).toBeNull();
    expect(dueWords(TODAY, "2026-11-26")).toBe("tomorrow");
    expect(dueWords(TODAY, "2026-11-22")).toBe("3 days late");
  });

  it("collects upkeep, cars, returns, chores, calendar and only the viewer's money", async () => {
    await db.delete(maintenanceTasks); // the migrations seed the real house schedule
    await maintenance.scheduleTask({ title: "Replace HVAC air filters", dueDate: "2026-11-20", parts: "16x25x1 filter" });
    await maintenance.scheduleTask({ title: "Flush water heater", dueDate: "2026-12-05" });
    await maintenance.scheduleTask({ title: "Clean gutters", dueDate: "2027-04-01" });
    const car = await maintenance.addVehicle({ name: "Honda", mileage: 41_800 }, { today: TODAY });
    await maintenance.scheduleTask({ title: "Oil change: Honda", dueDate: "2027-03-01", assetId: car, dueMileage: 42_000, area: "Vehicles" });
    await family.addReturn({ store: "Old Navy", itemName: "Jeans", returnDeadline: "2026-11-28" });
    await family.addReturn({ store: "REI", itemName: "Tent", returnDeadline: "2027-02-01" });
    const kid = await family.addKid({ name: "Leo" });
    await family.addChore({ kidId: kid, title: "Read 20 minutes", recurrence: "daily", stars: 2 }, NOW);
    await calendar.upsertEventFromSource({ module: "trips", ref: "t1" }, { title: "Fly to Denver", startDate: "2026-11-26" });
    await calendar.upsertEventFromSource({ module: "finance", ref: "f1" }, { title: "Card payment due", startDate: "2026-11-26" });

    const groups = await needsAttention("user1", TODAY, NOW);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(groups.every((g) => !g.failed)).toBe(true);

    expect(byKey.upkeep.items.map((i) => [i.title, i.tone])).toEqual([
      ["Replace HVAC air filters", "overdue"],
      ["Flush water heater", "soon"],
    ]);
    expect(byKey.cars.items).toHaveLength(1);
    expect(byKey.cars.items[0]).toMatchObject({ title: "Oil change: Honda", tone: "soon", detail: expect.stringContaining("200 mi to go") });
    expect(byKey.returns.items.map((i) => i.title)).toEqual(["Jeans (Old Navy)"]);
    expect(byKey.chores.items[0]).toMatchObject({ title: expect.stringContaining("Leo"), detail: expect.stringContaining("0 of 1 today") });
    // Finance reminders stay off the shared "Coming up" list.
    expect(byKey.calendar.items.map((i) => i.title)).toEqual(["Fly to Denver"]);

    // Pavel sees the joint $1,200 purchase, not Raisa's own $900 one.
    expect(byKey.money.items.find((i) => i.key === "large")?.title).toBe("1 large purchase to explain");
    const raisa = await needsAttention("user2", TODAY, NOW);
    expect(raisa.find((g) => g.key === "money")?.items.find((i) => i.key === "large")?.title).toBe("2 large purchases to explain");
  });
});

describe("home page upload", () => {
  it("sends only scrubbed text to Claude and cleans what comes back", async () => {
    await maintenance.addVehicle({ name: "Honda" }, { today: TODAY });
    runStructured.mockImplementation(async (opts: { payload: unknown }) => {
      const sent = JSON.stringify(opts.payload);
      expect(sent).not.toMatch(/4111|555-867-5309|pat@example\.com|Example|1HGCM82633A004352/);
      expect(sent).toContain("12/05/2026");
      expect(sent).toContain('"TODAY":"November 25, 2026"');
      expect(sent).toContain("Honda");
      return {
        what: "School flyer: winter concert",
        events: [
          { title: "Winter concert", date: "2026-12-05", endDate: null, startTime: "18:30", endTime: "25:00", location: "School gym", notes: "Wear white" },
          { title: "Bad date", date: "December 5", endDate: null, startTime: null, endTime: null, location: null, notes: null },
        ],
        returns: [],
        receipt: { merchant: "Target", date: "2026-11-22", total: 54.12, note: "Kids' winter boots" },
        binder: null,
        carDue: [{ kind: "registration", dueDate: "2027-01-31", car: "Honda" }],
        upkeep: [{ title: "Order 123456789", dueDate: null, recurrenceDays: null, parts: null }],
        newCard: false,
        advice: null,
      };
    });
    const r = await inbox.readUpload({
      text: "Winter concert 12-05-2026 at 6:30 PM. Questions? Call 555-867-5309 or pat@example.com. Card 4111 1111 1111 1111. VIN 1HGCM82633A004352",
      note: "From Pat Example",
      fileName: "flyer.jpg",
      fileKind: "image",
      today: TODAY,
    });
    expect(r.events).toEqual([
      { title: "Winter concert", date: "2026-12-05", endDate: null, startTime: "18:30", endTime: null, location: "School gym", notes: "Wear white" },
    ]);
    expect(r.upkeep).toEqual([]); // the identifier-looking title is dropped
    expect(r.carDue).toEqual([{ kind: "registration", dueDate: "2027-01-31", car: "Honda" }]);
    expect(r.receipt).toMatchObject({ merchant: "Target", total: 54.12 });
  });

  it("finds the receipt's bank charge only on accounts the member can see, and notes it", async () => {
    const pavel = await inbox.receiptMatches("user1", 54.12, "2026-11-23");
    expect(pavel.map((m) => m.id)).toEqual([ids.target]);
    await inbox.noteOnTransaction("user1", ids.target, "Kids' winter boots");
    await inbox.noteOnTransaction("user1", ids.target, "Kids' winter boots"); // not doubled
    const [row] = await db.select().from(financeTransactions).where((await import("drizzle-orm")).eq(financeTransactions.id, ids.target));
    expect(row.notes).toBe("Kids' winter boots");
    await expect(inbox.noteOnTransaction("user1", ids.herTarget, "x")).rejects.toThrow(/not found/);
  });

  it("moves a car's registration item to the new date instead of adding a second one", async () => {
    const car = await maintenance.addVehicle({ name: "Honda", mileage: 40_000 }, { standardItems: true, today: TODAY });
    expect(await inbox.fileCarDue({ carId: car, kind: "registration", dueDate: "2027-01-31" })).toEqual({ updated: true });
    expect(await inbox.fileCarDue({ carId: car, kind: "insurance", dueDate: "2027-03-15" })).toEqual({ updated: false });
    const open = await maintenance.listOpenTasks();
    expect(open.filter((t) => t.title.startsWith("Registration renewal"))).toEqual([expect.objectContaining({ dueDate: "2027-01-31", assetId: car })]);
    expect(open.find((t) => t.title === "Car insurance renewal: Honda")).toMatchObject({ dueDate: "2027-03-15", recurrenceDays: 365, area: "Vehicles" });
  });

  it("adds an upkeep item and refuses card numbers", async () => {
    await inbox.fileUpkeep({ title: "Descale dishwasher", dueDate: "2026-12-01", recurrenceDays: 90, parts: "Descaler" });
    expect((await maintenance.listOpenTasks()).find((t) => t.title === "Descale dishwasher")).toMatchObject({ recurrenceDays: 90, parts: "Descaler" });
    await expect(inbox.fileUpkeep({ title: "Pay 4111 1111 1111 1111", dueDate: TODAY, recurrenceDays: null, parts: null })).rejects.toThrow(/card number/);
  });
});
