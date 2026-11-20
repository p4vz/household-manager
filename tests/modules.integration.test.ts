import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { setDbForTests, type Db } from "@/core/db/client";
import * as schema from "@/core/db/schema";
import { registerModules } from "@/modules/registry";
import { listUpcoming } from "@/modules/calendar/api";
import { listExpectedExpenses } from "@/modules/finance/api";
import { completeTask, scheduleTask } from "@/modules/maintenance/api";
import { cancelTrip, planTrip } from "@/modules/trips/api";

beforeAll(async () => {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  setDbForTests(pg as unknown as Db);
  registerModules();
});

describe("modules talk to each other in-process", () => {
  it("a planned trip lands on the calendar and in finance, and cancelling removes the event", async () => {
    const tripId = await planTrip({
      name: "Lisbon",
      destination: "Lisbon, PT",
      startDate: "2027-05-01",
      endDate: "2027-05-08",
      budget: 3200,
    });
    let events = await listUpcoming("2027-01-01");
    expect(events).toContainEqual(expect.objectContaining({ title: "Trip: Lisbon", sourceModule: "trips" }));
    expect(await listExpectedExpenses("2027-01-01")).toContainEqual(
      expect.objectContaining({ title: "Trip: Lisbon", amount: 3200, category: "Travel" }),
    );

    await cancelTrip(tripId);
    events = await listUpcoming("2027-01-01");
    expect(events.find((e) => e.title === "Trip: Lisbon")).toBeUndefined();
  });

  it("maintenance tasks become calendar reminders and expected expenses", async () => {
    const id = await scheduleTask({ title: "Furnace service", dueDate: "2027-02-10", estimatedCost: 180 });
    expect(await listUpcoming("2027-01-01")).toContainEqual(
      expect.objectContaining({ title: "Maintenance: Furnace service" }),
    );
    await completeTask(id, { date: "2027-02-11", actualCost: 215 });
    const expected = await listExpectedExpenses("2027-01-01");
    const row = expected.filter((e) => e.title === "Furnace service");
    expect(row).toHaveLength(1); // upserted, not duplicated
    expect(row[0].amount).toBe(215);
  });
});
