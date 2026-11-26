import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/core/db/client";
import { tripsItineraryItems, tripsTrips } from "./schema";

/** Itinerary steps (flights, stays, plans) added to an active trip after `since`. */
export async function tripChangesSince(since: Date): Promise<{ id: string; title: string; trip: string; slug: string }[]> {
  return db()
    .select({ id: tripsItineraryItems.id, title: tripsItineraryItems.title, trip: tripsTrips.name, slug: tripsTrips.slug })
    .from(tripsItineraryItems)
    .innerJoin(tripsTrips, eq(tripsTrips.id, tripsItineraryItems.tripId))
    .where(and(gt(tripsItineraryItems.createdAt, since), eq(tripsTrips.archived, false), eq(tripsTrips.status, "planned")))
    .orderBy(desc(tripsItineraryItems.createdAt))
    .limit(20);
}
