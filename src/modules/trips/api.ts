import "server-only";
import { asc, eq } from "drizzle-orm";
import { bus } from "@/core/bus";
import { db } from "@/core/db/client";
import { tripsTrips } from "./schema";

/** Trip planner public API. Scaffold: trips with dates and a budget. */
export async function planTrip(input: {
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  budget?: number | null;
}) {
  const [trip] = await db()
    .insert(tripsTrips)
    .values({ ...input, budget: input.budget ?? null })
    .returning();
  await bus.publish("trips", "trips.tripPlanned", {
    tripId: trip.id,
    name: trip.name,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    budget: trip.budget,
  });
  return trip.id;
}

export async function cancelTrip(tripId: string) {
  await db().update(tripsTrips).set({ status: "cancelled" }).where(eq(tripsTrips.id, tripId));
  await bus.publish("trips", "trips.tripCancelled", { tripId });
}

export async function listTrips() {
  return db().select().from(tripsTrips).orderBy(asc(tripsTrips.startDate));
}
