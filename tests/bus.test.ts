import { describe, expect, it } from "vitest";
import { EventBus } from "@/core/bus/bus";

const trip = {
  tripId: "t1",
  name: "Lisbon",
  destination: "Lisbon",
  startDate: "2027-05-01",
  endDate: "2027-05-08",
  budget: 3000,
};

describe("event bus", () => {
  it("delivers to every subscriber and isolates failures", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("trips.tripPlanned", "calendar", (e) => void seen.push(`cal:${e.tripId}`));
    bus.subscribe("trips.tripPlanned", "finance", () => {
      throw new Error("boom");
    });
    const res = await bus.publish("trips", "trips.tripPlanned", trip);
    expect(seen).toEqual(["cal:t1"]);
    expect(res).toEqual([
      { module: "calendar", ok: true },
      { module: "finance", ok: false, error: "boom" },
    ]);
  });
  it("only lets the owning module publish its events", async () => {
    const bus = new EventBus();
    await expect(bus.publish("finance", "trips.tripPlanned", trip)).rejects.toThrow(/may not publish/);
  });
  it("validates payloads against the event catalogue", async () => {
    const bus = new EventBus();
    await expect(
      bus.publish("trips", "trips.tripPlanned", { ...trip, startDate: "next week" }),
    ).rejects.toThrow();
  });
});
