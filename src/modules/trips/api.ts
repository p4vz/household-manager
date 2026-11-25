import "server-only";
import { and, asc, count, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { bus } from "@/core/bus";
import { db } from "@/core/db/client";
import { listCreditCards, planCardsForPurchases } from "@/modules/finance/api";
import {
  aiConfigured,
  generateAllergyCards,
  generateHunt,
  generateQuiz,
  generateTrivia,
  suggestPacking,
} from "./ai";
import { toPlannedPurchases, tripTotal } from "./card-plan";
import { parsePastedPlaces, type GfCandidate } from "./dining-import";
import { searchGlutenFreeNearby } from "./external/osm";
import { fetchForecast, geocodePlace, summariseForecast, describeWeatherCode } from "./external/weather";
import { fetchWikiSummary } from "./external/wiki";
import { collapseToTemplate, expandTemplate } from "./packing";
import {
  tripsAllergyCards,
  tripsDestinations,
  tripsDiningPlaces,
  tripsDocuments,
  tripsEmergencyInfo,
  tripsHuntCompletions,
  tripsHuntTasks,
  tripsHunts,
  tripsItineraryItems,
  tripsPackingItems,
  tripsPackingLists,
  tripsPackingTemplateItems,
  tripsPackingTemplates,
  tripsQuizAttempts,
  tripsQuizQuestions,
  tripsQuizzes,
  tripsTravelers,
  tripsTriviaFacts,
  tripsTrips,
  type BookingStatus,
  type EmergencyEntry,
  type GfStatus,
  type ItineraryKind,
  type PackingCategory,
  DOCUMENT_KINDS,
} from "./schema";
import { languageName, nightsBetween, slugify } from "./ui/format";
import { openBytes, sealBytes, vaultConfigured } from "./vault";

/**
 * Trip planner public API. Pages, server actions and other modules use only
 * these functions. Ported from the standalone family trip assistant; see
 * docs/ARCHITECTURE.md ("Trips") for what changed in the move.
 */

export { aiConfigured, vaultConfigured };
export { ITINERARY_KINDS, BOOKING_STATUSES, PACKING_CATEGORIES, GF_STATUSES, DOCUMENT_KINDS, TRAVELER_KINDS } from "./schema";
export type { ItineraryKind, BookingStatus, PackingCategory, GfStatus } from "./schema";

const today = () => new Date().toISOString().slice(0, 10);

class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`);
  }
}

async function one<T>(rows: Promise<T[]>, what: string): Promise<T> {
  const [row] = await rows;
  if (!row) throw new NotFound(what);
  return row;
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set(
    (await db().select({ slug: tripsTrips.slug }).from(tripsTrips).where(sql`${tripsTrips.slug} like ${`${base}%`}`)).map((r) => r.slug),
  );
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

/** Tell calendar and finance the current shape of a trip. Safe to call repeatedly. */
export async function publishTrip(tripId: string) {
  const trip = await one(db().select().from(tripsTrips).where(eq(tripsTrips.id, tripId)), "Trip");
  if (trip.status === "cancelled") return;
  const items = await db()
    .select({ cost: tripsItineraryItems.cost, bookingStatus: tripsItineraryItems.bookingStatus })
    .from(tripsItineraryItems)
    .where(eq(tripsItineraryItems.tripId, tripId));
  await bus.publish("trips", "trips.tripPlanned", {
    tripId: trip.id,
    name: trip.name,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    budget: tripTotal(trip.budget, items),
  });
}

/** Create a trip. Kept for callers of the scaffold API; createTrip adds destinations. */
export async function planTrip(input: {
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  budget?: number | null;
  notes?: string | null;
}) {
  if (input.endDate < input.startDate) throw new Error("The trip ends before it starts");
  const [trip] = await db()
    .insert(tripsTrips)
    .values({ ...input, budget: input.budget ?? null, notes: input.notes ?? null, slug: await uniqueSlug(input.name) })
    .returning();
  await publishTrip(trip.id);
  return trip.id;
}

/** New trip from a list of place names, geocoded so weather and dining search work at once. */
export async function createTrip(input: { name: string; startDate: string; endDate: string; places: string[]; budget: number | null }) {
  const geos = await Promise.all(input.places.map(async (p) => ({ query: p, geo: await geocodePlace(p) })));
  const id = await planTrip({
    name: input.name,
    destination: geos.map((g) => g.geo?.name ?? g.query).join(", ") || "TBD",
    startDate: input.startDate,
    endDate: input.endDate,
    budget: input.budget,
  });
  for (const [i, g] of geos.entries()) {
    await db().insert(tripsDestinations).values({
      tripId: id,
      name: g.geo?.name ?? g.query,
      country: g.geo?.country ?? null,
      countryCode: g.geo?.countryCode ?? null,
      latitude: g.geo?.latitude ?? null,
      longitude: g.geo?.longitude ?? null,
      timezone: g.geo?.timezone ?? null,
      languages: defaultLanguages(g.geo?.countryCode),
      sortOrder: i,
    });
  }
  const [trip] = await db().select({ slug: tripsTrips.slug }).from(tripsTrips).where(eq(tripsTrips.id, id));
  return { id, slug: trip.slug };
}

export async function updateTrip(tripId: string, patch: { name: string; startDate: string; endDate: string; budget: number | null; notes: string | null }) {
  if (patch.endDate < patch.startDate) throw new Error("The trip ends before it starts");
  await db().update(tripsTrips).set(patch).where(eq(tripsTrips.id, tripId));
  await publishTrip(tripId);
}

export async function cancelTrip(tripId: string) {
  await db().update(tripsTrips).set({ status: "cancelled" }).where(eq(tripsTrips.id, tripId));
  await bus.publish("trips", "trips.tripCancelled", { tripId });
}

export async function archiveTrip(tripId: string) {
  await db().update(tripsTrips).set({ archived: true }).where(eq(tripsTrips.id, tripId));
}

/** The trip's switch for letting assistants read its booking codes. */
export async function setBookingCodeSharing(tripId: string, on: boolean) {
  await one(db().select({ id: tripsTrips.id }).from(tripsTrips).where(eq(tripsTrips.id, tripId)), "Trip");
  await db().update(tripsTrips).set({ shareBookingCodes: on }).where(eq(tripsTrips.id, tripId));
}

export async function listTrips(opts: { includeArchived?: boolean } = {}) {
  return db()
    .select()
    .from(tripsTrips)
    .where(opts.includeArchived ? undefined : eq(tripsTrips.archived, false))
    .orderBy(asc(tripsTrips.startDate));
}

export async function getTrip(slug: string) {
  const [trip] = await db().select().from(tripsTrips).where(eq(tripsTrips.slug, slug));
  if (!trip) return null;
  const destinations = await db()
    .select()
    .from(tripsDestinations)
    .where(eq(tripsDestinations.tripId, trip.id))
    .orderBy(asc(tripsDestinations.sortOrder));
  return { ...trip, destinations };
}

async function syncDestinationSummary(tripId: string) {
  const names = await db()
    .select({ name: tripsDestinations.name })
    .from(tripsDestinations)
    .where(eq(tripsDestinations.tripId, tripId))
    .orderBy(asc(tripsDestinations.sortOrder));
  await db().update(tripsTrips).set({ destination: names.map((n) => n.name).join(", ") || "TBD" }).where(eq(tripsTrips.id, tripId));
  await publishTrip(tripId);
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** First guess at the languages to write allergy cards in, from the country. */
const COUNTRY_LANGUAGES: Record<string, string[]> = {
  AT: ["de"], CH: ["de", "fr", "it"], DE: ["de"], IT: ["it"], FR: ["fr"], ES: ["es"], PT: ["pt"], NL: ["nl"],
  BE: ["nl", "fr"], GR: ["el"], JP: ["ja"], MX: ["es"], CZ: ["cs"], HR: ["hr"], PL: ["pl"], IS: ["is"],
  DK: ["da"], SE: ["sv"], NO: ["no"], FI: ["fi"], HU: ["hu"], TR: ["tr"], KR: ["ko"], CN: ["zh"], TH: ["th"],
};

function defaultLanguages(countryCode?: string | null): string[] {
  return COUNTRY_LANGUAGES[countryCode?.toUpperCase() ?? ""] ?? [];
}

export async function addDestination(tripId: string, input: { name: string; arriveOn: string | null; departOn: string | null }) {
  await one(db().select({ id: tripsTrips.id }).from(tripsTrips).where(eq(tripsTrips.id, tripId)), "Trip");
  const geo = await geocodePlace(input.name);
  const [{ n }] = await db().select({ n: count() }).from(tripsDestinations).where(eq(tripsDestinations.tripId, tripId));
  await db().insert(tripsDestinations).values({
    tripId,
    name: geo?.name ?? input.name,
    country: geo?.country ?? null,
    countryCode: geo?.countryCode ?? null,
    latitude: geo?.latitude ?? null,
    longitude: geo?.longitude ?? null,
    timezone: geo?.timezone ?? null,
    languages: defaultLanguages(geo?.countryCode),
    arriveOn: input.arriveOn,
    departOn: input.departOn,
    sortOrder: n,
  });
  await syncDestinationSummary(tripId);
}

export async function updateDestination(id: string, patch: { arriveOn: string | null; departOn: string | null; languages: string[] }) {
  await db().update(tripsDestinations).set(patch).where(eq(tripsDestinations.id, id));
}

export async function deleteDestination(id: string) {
  const d = await one(db().select({ tripId: tripsDestinations.tripId }).from(tripsDestinations).where(eq(tripsDestinations.id, id)), "Destination");
  await db().delete(tripsDestinations).where(eq(tripsDestinations.id, id));
  await syncDestinationSummary(d.tripId);
}

async function destination(id: string) {
  return one(db().select().from(tripsDestinations).where(eq(tripsDestinations.id, id)), "Destination");
}

/** Forecast per destination (Open-Meteo only covers about 16 days ahead). */
export async function tripWeather(trip: { startDate: string; endDate: string; destinations: { id: string; name: string; latitude: number | null; longitude: number | null; arriveOn: string | null; departOn: string | null }[] }) {
  return Promise.all(
    trip.destinations
      .filter((d) => d.latitude != null && d.longitude != null)
      .map(async (d) => {
        const days = await fetchForecast(d.latitude!, d.longitude!, d.arriveOn ?? trip.startDate, d.departOn ?? trip.endDate);
        return {
          destinationId: d.id,
          name: d.name,
          summary: summariseForecast(days),
          days: days.map((x) => ({ ...x, label: describeWeatherCode(x.weatherCode) })),
        };
      }),
  );
}

// ---------------------------------------------------------------------------
// Itinerary
// ---------------------------------------------------------------------------

export type ItineraryInput = {
  destinationId: string | null;
  kind: ItineraryKind;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  timezone: string | null;
  endTimezone: string | null;
  location: string | null;
  confirmation: string | null;
  notes: string | null;
  provider: string | null;
  bookingUrl: string | null;
  bookingOpensOn: string | null;
  cost: number | null;
  gfVetted: boolean;
};

export async function listItinerary(tripId: string) {
  return db()
    .select()
    .from(tripsItineraryItems)
    .where(eq(tripsItineraryItems.tripId, tripId))
    .orderBy(asc(tripsItineraryItems.startsAt));
}

export async function addItineraryItem(tripId: string, input: ItineraryInput) {
  await one(db().select({ id: tripsTrips.id }).from(tripsTrips).where(eq(tripsTrips.id, tripId)), "Trip");
  if (input.destinationId) {
    const d = await destination(input.destinationId);
    if (d.tripId !== tripId) throw new NotFound("Destination");
  }
  await db().insert(tripsItineraryItems).values({ tripId, ...input });
  await publishTrip(tripId);
}

async function itemTrip(id: string) {
  return one(
    db().select({ tripId: tripsItineraryItems.tripId }).from(tripsItineraryItems).where(eq(tripsItineraryItems.id, id)),
    "Itinerary step",
  );
}

/**
 * Moves a step along its booking lifecycle. Only "confirmed" asserts that a
 * person checked it against the operator, so only that stamps verifiedAt.
 */
export async function updateBooking(
  id: string,
  input: {
    bookingStatus: BookingStatus;
    confirmation: string | null;
    provider: string | null;
    bookingUrl: string | null;
    seatNote: string | null;
    verifyBy: string | null;
    cost: number | null;
    paidWithAccountId: string | null;
    chargeDate: string | null;
  },
  checkedBy: string,
) {
  const { tripId } = await itemTrip(id);
  if (input.paidWithAccountId) {
    const cards = await listCreditCards();
    if (!cards.some((c) => c.accountId === input.paidWithAccountId)) throw new NotFound("Card");
  }
  await db()
    .update(tripsItineraryItems)
    .set({
      ...input,
      verifiedAt: input.bookingStatus === "confirmed" ? new Date() : null,
      verifiedNote: input.bookingStatus === "confirmed" ? `Checked by ${checkedBy}` : null,
      updatedAt: new Date(),
    })
    .where(eq(tripsItineraryItems.id, id));
  await publishTrip(tripId);
}

export async function deleteItineraryItem(id: string) {
  const { tripId } = await itemTrip(id);
  await db().delete(tripsItineraryItems).where(eq(tripsItineraryItems.id, id));
  await publishTrip(tripId);
}

/** What still needs doing across upcoming trips, soonest deadline first. */
export async function outstandingBookings(on = today()) {
  const rows = await db()
    .select({
      id: tripsItineraryItems.id,
      title: tripsItineraryItems.title,
      kind: tripsItineraryItems.kind,
      startsAt: tripsItineraryItems.startsAt,
      bookingStatus: tripsItineraryItems.bookingStatus,
      bookingOpensOn: tripsItineraryItems.bookingOpensOn,
      verifyBy: tripsItineraryItems.verifyBy,
      tripName: tripsTrips.name,
      tripSlug: tripsTrips.slug,
    })
    .from(tripsItineraryItems)
    .innerJoin(tripsTrips, eq(tripsTrips.id, tripsItineraryItems.tripId))
    .where(
      and(
        eq(tripsTrips.archived, false),
        eq(tripsTrips.status, "planned"),
        sql`${tripsTrips.endDate} >= ${on}`,
        or(
          inArray(tripsItineraryItems.bookingStatus, ["idea", "needs_booking"]),
          and(eq(tripsItineraryItems.bookingStatus, "booked"), sql`${tripsItineraryItems.verifyBy} is not null`),
        ),
      ),
    );
  const deadline = (r: (typeof rows)[number]) => r.verifyBy ?? r.bookingOpensOn ?? r.startsAt.toISOString().slice(0, 10);
  return rows.sort((a, b) => deadline(a).localeCompare(deadline(b)));
}

// ---------------------------------------------------------------------------
// Card rewards: which household card to book each step with
// ---------------------------------------------------------------------------

/**
 * Card advice for a trip's unpaid bookings, from finance's reward profiles:
 * the best card per booking, and open sign-up bonuses that the trip's spend
 * could meet before their deadlines.
 */
export async function tripCardPlan(tripId: string, now = new Date()) {
  const items = await listItinerary(tripId);
  const purchases = toPlannedPurchases(items, now.toISOString().slice(0, 10));
  const [plan, cards] = await Promise.all([planCardsForPurchases(purchases, now), listCreditCards()]);
  const byRef = new Map(plan.purchases.map((p) => [p.ref, p]));
  const cardName = new Map(cards.map((c) => [c.accountId, c.name]));
  return {
    hasProfiles: plan.cards.length > 0,
    cards,
    bonuses: plan.bonuses,
    steps: items
      .filter((i) => i.cost != null && i.bookingStatus !== "cancelled")
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        provider: i.provider,
        cost: i.cost!,
        chargeDate: purchases.find((p) => p.ref === i.id)?.date ?? i.chargeDate,
        bookingStatus: i.bookingStatus,
        paidWith: i.paidWithAccountId ? (cardName.get(i.paidWithAccountId) ?? "a card that is no longer active") : null,
        plan: byRef.get(i.id) ?? null,
      })),
  };
}

export { listCreditCards };

// ---------------------------------------------------------------------------
// Travellers and diet
// ---------------------------------------------------------------------------

export async function listTravelers() {
  return db().select().from(tripsTravelers).orderBy(asc(tripsTravelers.createdAt));
}

export async function addTraveler(input: { name: string; kind: "adult" | "child"; birthdate: string | null; owner: "user1" | "user2" | null }) {
  await db().insert(tripsTravelers).values(input);
}

export async function deleteTraveler(id: string) {
  await db().delete(tripsTravelers).where(eq(tripsTravelers.id, id));
}

/** The dietary profile. Coeliac is medical; it changes card wording and dining warnings. */
export async function saveDietProfile(
  id: string,
  p: { celiac: boolean; glutenFree: boolean; crossContactStrict: boolean; otherAllergens: string[]; dietNotes: string | null },
) {
  await db().update(tripsTravelers).set(p).where(eq(tripsTravelers.id, id));
}

function ageOn(birthdate: string | null, on: string): number | null {
  if (!birthdate) return null;
  const [by, bm, bd] = birthdate.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

export async function listTemplates() {
  const templates = await db().select().from(tripsPackingTemplates).orderBy(asc(tripsPackingTemplates.name));
  const items = templates.length
    ? await db()
        .select()
        .from(tripsPackingTemplateItems)
        .where(inArray(tripsPackingTemplateItems.templateId, templates.map((t) => t.id)))
        .orderBy(asc(tripsPackingTemplateItems.sortOrder))
    : [];
  return templates.map((t) => ({ ...t, items: items.filter((i) => i.templateId === t.id) }));
}

export async function createTemplate(input: { name: string; description: string | null; tags: string[] }) {
  await db().insert(tripsPackingTemplates).values(input);
}

export async function deleteTemplate(id: string) {
  await db().delete(tripsPackingTemplates).where(eq(tripsPackingTemplates.id, id));
}

export async function addTemplateItem(templateId: string, input: { name: string; category: PackingCategory; quantity: number; perPerson: boolean }) {
  const [{ n }] = await db().select({ n: count() }).from(tripsPackingTemplateItems).where(eq(tripsPackingTemplateItems.templateId, templateId));
  await db().insert(tripsPackingTemplateItems).values({ templateId, ...input, sortOrder: n });
}

export async function deleteTemplateItem(id: string) {
  await db().delete(tripsPackingTemplateItems).where(eq(tripsPackingTemplateItems.id, id));
}

export async function tripPacking(tripId: string) {
  const lists = await db().select().from(tripsPackingLists).where(eq(tripsPackingLists.tripId, tripId)).orderBy(asc(tripsPackingLists.createdAt));
  const items = lists.length
    ? await db()
        .select()
        .from(tripsPackingItems)
        .where(inArray(tripsPackingItems.listId, lists.map((l) => l.id)))
        .orderBy(asc(tripsPackingItems.sortOrder))
    : [];
  return lists.map((l) => ({ ...l, items: items.filter((i) => i.listId === l.id) }));
}

/** Clone a reusable template into this trip, expanded per traveller. */
export async function applyTemplateToTrip(tripId: string, templateId: string, travelerIds: string[]) {
  if (travelerIds.length === 0) throw new Error("Choose at least one traveller");
  const template = await one(db().select().from(tripsPackingTemplates).where(eq(tripsPackingTemplates.id, templateId)), "Packing template");
  const source = await db()
    .select()
    .from(tripsPackingTemplateItems)
    .where(eq(tripsPackingTemplateItems.templateId, templateId))
    .orderBy(asc(tripsPackingTemplateItems.sortOrder));
  const [list] = await db().insert(tripsPackingLists).values({ tripId, templateId, name: template.name }).returning();
  const rows = expandTemplate(source, travelerIds).map((r, i) => ({ ...r, listId: list.id, sortOrder: i }));
  if (rows.length) await db().insert(tripsPackingItems).values(rows);
  return list.id;
}

export async function createEmptyList(tripId: string, name: string) {
  await db().insert(tripsPackingLists).values({ tripId, name });
}

export async function addPackingItem(listId: string, input: { name: string; category: PackingCategory; quantity: number; travelerId: string | null }) {
  const [{ n }] = await db().select({ n: count() }).from(tripsPackingItems).where(eq(tripsPackingItems.listId, listId));
  await db().insert(tripsPackingItems).values({ listId, ...input, sortOrder: n });
}

export async function togglePackingItem(id: string) {
  await db().update(tripsPackingItems).set({ packed: sql`not ${tripsPackingItems.packed}` }).where(eq(tripsPackingItems.id, id));
}

export async function deletePackingItem(id: string) {
  await db().delete(tripsPackingItems).where(eq(tripsPackingItems.id, id));
}

/** Turn a trip list that worked well into a template for next time. */
export async function saveListAsTemplate(listId: string, name: string) {
  const items = await db().select().from(tripsPackingItems).where(eq(tripsPackingItems.listId, listId)).orderBy(asc(tripsPackingItems.sortOrder));
  const [template] = await db().insert(tripsPackingTemplates).values({ name }).returning();
  const rows = collapseToTemplate(items).map((r, i) => ({ ...r, templateId: template.id, sortOrder: i }));
  if (rows.length) await db().insert(tripsPackingTemplateItems).values(rows);
}

/** Ask the AI what is missing, grounded in the forecast and who is going; suggestions are appended as normal items. */
export async function suggestForList(listId: string) {
  if (!(await aiConfigured())) throw new Error("Add a Gemini or Claude API key to use suggestions");
  const list = await one(db().select().from(tripsPackingLists).where(eq(tripsPackingLists.id, listId)), "Packing list");
  const trip = await one(db().select().from(tripsTrips).where(eq(tripsTrips.id, list.tripId)), "Trip");
  const [dests, items, travelers] = await Promise.all([
    db().select().from(tripsDestinations).where(eq(tripsDestinations.tripId, trip.id)).orderBy(asc(tripsDestinations.sortOrder)),
    db().select({ name: tripsPackingItems.name }).from(tripsPackingItems).where(eq(tripsPackingItems.listId, listId)),
    listTravelers(),
  ]);
  const first = dests.find((d) => d.latitude != null && d.longitude != null);
  const weather = first ? summariseForecast(await fetchForecast(first.latitude!, first.longitude!, trip.startDate, trip.endDate)) : null;
  const result = await suggestPacking({
    destinations: dests.map((d) => d.name),
    nights: nightsBetween(trip.startDate, trip.endDate),
    travelers: travelers.map((t) => {
      const age = ageOn(t.birthdate, trip.startDate);
      return t.kind === "child" ? `child${age != null ? `, age ${age}` : ""}` : "adult";
    }),
    weather,
    glutenFree: travelers.some((t) => t.celiac || t.glutenFree),
    existingItems: items.map((i) => i.name),
  });
  const offset = items.length;
  if (result.items.length) {
    await db()
      .insert(tripsPackingItems)
      .values(
        result.items.slice(0, 20).map((s, i) => ({
          listId,
          name: s.name,
          category: s.category,
          quantity: Math.max(1, s.quantity),
          notes: s.reason,
          sortOrder: offset + i,
        })),
      );
  }
}

// ---------------------------------------------------------------------------
// Gluten-free dining and allergy cards
// ---------------------------------------------------------------------------

export async function diningForTrip(tripId: string) {
  const dests = await db().select({ id: tripsDestinations.id }).from(tripsDestinations).where(eq(tripsDestinations.tripId, tripId));
  if (dests.length === 0) return [];
  return db()
    .select()
    .from(tripsDiningPlaces)
    .where(inArray(tripsDiningPlaces.destinationId, dests.map((d) => d.id)))
    .orderBy(
      // Dedicated kitchens first; "avoid" last but kept, so nobody re-adds it.
      sql`case ${tripsDiningPlaces.gfStatus} when 'dedicated_gf' then 0 when 'gf_menu' then 1 when 'accommodating' then 2 when 'unknown' then 3 else 4 end`,
      desc(tripsDiningPlaces.favorite),
      asc(tripsDiningPlaces.name),
    );
}

export async function addDiningPlace(input: {
  destinationId: string | null;
  name: string;
  cuisine: string | null;
  address: string | null;
  website: string | null;
  fmgfUrl: string | null;
  gfStatus: GfStatus;
  dedicatedFryer: boolean | null;
  notes: string | null;
}) {
  await db().insert(tripsDiningPlaces).values({ ...input, source: input.fmgfUrl ? "find_me_gluten_free" : "manual" });
}

export async function updateDiningPlace(id: string, p: { visited: boolean; favorite: boolean; ourRating: number | null; gfStatus: GfStatus; notes: string | null }) {
  await db().update(tripsDiningPlaces).set(p).where(eq(tripsDiningPlaces.id, id));
}

export async function deleteDiningPlace(id: string) {
  await db().delete(tripsDiningPlaces).where(eq(tripsDiningPlaces.id, id));
}

/** Insert new venues; on a repeat import refresh only source-owned facts, never our notes or rating. */
async function upsertCandidates(destinationId: string | null, places: GfCandidate[]) {
  for (const p of places) {
    await db()
      .insert(tripsDiningPlaces)
      .values({
        destinationId,
        name: p.name,
        cuisine: p.cuisine ?? null,
        address: p.address ?? null,
        latitude: p.latitude ?? null,
        longitude: p.longitude ?? null,
        phone: p.phone ?? null,
        website: p.website ?? null,
        source: p.source,
        sourceRef: p.sourceRef,
        gfStatus: p.gfStatus,
        celiacFriendly: p.celiacFriendly ?? null,
        notes: p.notes ?? null,
      })
      .onConflictDoUpdate({
        target: [tripsDiningPlaces.source, tripsDiningPlaces.sourceRef],
        set: {
          address: sql`coalesce(excluded.address, ${tripsDiningPlaces.address})`,
          phone: sql`coalesce(excluded.phone, ${tripsDiningPlaces.phone})`,
          website: sql`coalesce(excluded.website, ${tripsDiningPlaces.website})`,
          latitude: sql`coalesce(excluded.latitude, ${tripsDiningPlaces.latitude})`,
          longitude: sql`coalesce(excluded.longitude, ${tripsDiningPlaces.longitude})`,
        },
      });
  }
}

/** Gluten-free venues near a destination, from OpenStreetMap. */
export async function discoverNearby(destinationId: string, radiusMeters: number) {
  const d = await destination(destinationId);
  if (d.latitude == null || d.longitude == null) throw new Error("This destination has no coordinates yet");
  const found = await searchGlutenFreeNearby({ latitude: d.latitude, longitude: d.longitude, radiusMeters });
  await upsertCandidates(d.id, found);
  return found.length;
}

/** Bulk-add places copied out of Find Me Gluten Free (it has no export). */
export async function importPastedPlaces(destinationId: string | null, text: string) {
  const { places, skipped } = parsePastedPlaces(text);
  await upsertCandidates(destinationId, places);
  return { added: places.length, skipped };
}

export async function allergyCardsForTrip(tripId: string) {
  return db()
    .select({
      card: tripsAllergyCards,
      destination: tripsDestinations.name,
      traveler: tripsTravelers.name,
    })
    .from(tripsAllergyCards)
    .innerJoin(tripsDestinations, eq(tripsDestinations.id, tripsAllergyCards.destinationId))
    .innerJoin(tripsTravelers, eq(tripsTravelers.id, tripsAllergyCards.travelerId))
    .where(eq(tripsDestinations.tripId, tripId))
    .orderBy(asc(tripsDestinations.sortOrder), asc(tripsAllergyCards.language));
}

/**
 * Printable cards in each of a destination's languages for everyone marked
 * coeliac or gluten-free. Regenerating resets the human-verified flag,
 * because the wording changed.
 */
export async function generateCardsForDestination(destinationId: string) {
  if (!(await aiConfigured())) throw new Error("Add a Gemini or Claude API key to write allergy cards");
  const d = await destination(destinationId);
  if (d.languages.length === 0) throw new Error("Add at least one language for this destination");
  const people = (await listTravelers()).filter((t) => t.celiac || t.glutenFree);
  if (people.length === 0) throw new Error("Mark someone as coeliac or gluten-free under Travellers first");
  for (const t of people) {
    const result = await generateAllergyCards({
      languages: d.languages.map((code) => ({ code, name: languageName(code) })),
      celiac: t.celiac,
      crossContactStrict: t.crossContactStrict,
      otherAllergens: t.otherAllergens,
    });
    for (const c of result.cards) {
      await db()
        .insert(tripsAllergyCards)
        .values({ destinationId: d.id, travelerId: t.id, language: c.language, languageName: c.languageName, body: c.body, englishBody: c.englishBody })
        .onConflictDoUpdate({
          target: [tripsAllergyCards.destinationId, tripsAllergyCards.language, tripsAllergyCards.travelerId],
          set: { body: c.body, englishBody: c.englishBody, languageName: c.languageName, verified: false },
        });
    }
  }
}

export async function toggleCardVerified(id: string) {
  await db().update(tripsAllergyCards).set({ verified: sql`not ${tripsAllergyCards.verified}` }).where(eq(tripsAllergyCards.id, id));
}

// ---------------------------------------------------------------------------
// Trivia and kids mode
// ---------------------------------------------------------------------------

export async function triviaForTrip(tripId: string) {
  return db()
    .select({ fact: tripsTriviaFacts, destinationId: tripsDestinations.id })
    .from(tripsTriviaFacts)
    .innerJoin(tripsDestinations, eq(tripsDestinations.id, tripsTriviaFacts.destinationId))
    .where(eq(tripsDestinations.tripId, tripId))
    .orderBy(asc(tripsDestinations.sortOrder), asc(tripsTriviaFacts.createdAt));
}

/** Trivia grounded in the place's Wikipedia summary, with the source kept beside each fact. */
export async function generateTriviaFor(destinationId: string) {
  if (!(await aiConfigured())) throw new Error("Add a Gemini or Claude API key to generate trivia");
  const d = await destination(destinationId);
  const wiki = await fetchWikiSummary(d.name);
  const result = await generateTrivia({ place: d.name, country: d.country, reference: wiki?.extract ?? null, count: 12 });
  if (result.facts.length) {
    await db()
      .insert(tripsTriviaFacts)
      .values(
        result.facts.map((f) => ({
          destinationId: d.id,
          text: f.text,
          category: f.category,
          kidFriendly: f.kidFriendly,
          sourceName: wiki ? "Wikipedia" : null,
          sourceUrl: wiki?.url ?? null,
        })),
      );
  }
}

export async function deleteTriviaFact(id: string) {
  await db().delete(tripsTriviaFacts).where(eq(tripsTriviaFacts.id, id));
}

export async function kidsForTrip(tripId: string) {
  const dests = await db().select({ id: tripsDestinations.id }).from(tripsDestinations).where(eq(tripsDestinations.tripId, tripId));
  const destIds = dests.map((d) => d.id);
  const quizzes = destIds.length ? await db().select().from(tripsQuizzes).where(inArray(tripsQuizzes.destinationId, destIds)).orderBy(desc(tripsQuizzes.createdAt)) : [];
  const quizIds = quizzes.map((q) => q.id);
  const [questions, attempts, hunts] = await Promise.all([
    quizIds.length ? db().select().from(tripsQuizQuestions).where(inArray(tripsQuizQuestions.quizId, quizIds)).orderBy(asc(tripsQuizQuestions.sortOrder)) : [],
    quizIds.length ? db().select().from(tripsQuizAttempts).where(inArray(tripsQuizAttempts.quizId, quizIds)).orderBy(desc(tripsQuizAttempts.completedAt)) : [],
    db().select().from(tripsHunts).where(eq(tripsHunts.tripId, tripId)).orderBy(desc(tripsHunts.createdAt)),
  ]);
  const huntIds = hunts.map((h) => h.id);
  const tasks = huntIds.length ? await db().select().from(tripsHuntTasks).where(inArray(tripsHuntTasks.huntId, huntIds)).orderBy(asc(tripsHuntTasks.sortOrder)) : [];
  const completions = tasks.length ? await db().select().from(tripsHuntCompletions).where(inArray(tripsHuntCompletions.taskId, tasks.map((t) => t.id))) : [];
  return {
    // Answers stay on the server; the page only needs the choices.
    quizzes: quizzes.map((q) => ({
      ...q,
      questions: questions
        .filter((x) => x.quizId === q.id)
        .map((x) => ({ id: x.id, prompt: x.prompt, choices: x.choices, points: x.points, sortOrder: x.sortOrder })),
      attempts: attempts.filter((a) => a.quizId === q.id),
    })),
    hunts: hunts.map((h) => ({
      ...h,
      tasks: tasks.filter((t) => t.huntId === h.id).map((t) => ({ ...t, doneBy: completions.filter((c) => c.taskId === t.id).map((c) => c.travelerId) })),
    })),
  };
}

/** A kids' quiz built from the trivia already gathered for the place. */
export async function generateQuizFor(destinationId: string, minAge: number) {
  if (!(await aiConfigured())) throw new Error("Add a Gemini or Claude API key to generate quizzes");
  const d = await destination(destinationId);
  const facts = await db().select({ text: tripsTriviaFacts.text }).from(tripsTriviaFacts).where(eq(tripsTriviaFacts.destinationId, d.id)).limit(20);
  if (facts.length === 0) throw new Error("Generate trivia for this place first. The quiz is built from it.");
  const q = await generateQuiz({ place: d.name, minAge, facts: facts.map((f) => f.text) });
  const [quiz] = await db().insert(tripsQuizzes).values({ destinationId: d.id, title: q.title, minAge }).returning();
  const valid = q.questions.filter((x) => x.choices.length >= 2 && x.answerIndex >= 0 && x.answerIndex < x.choices.length);
  if (valid.length) {
    await db()
      .insert(tripsQuizQuestions)
      .values(valid.map((x, i) => ({ quizId: quiz.id, prompt: x.prompt, choices: x.choices, answerIndex: x.answerIndex, explanation: x.explanation, sortOrder: i })));
  }
}

/** Scored on the server from the submitted answers; the client never sends a score. */
export async function recordQuizAttempt(quizId: string, travelerId: string, answers: Record<string, number>) {
  await one(db().select({ id: tripsTravelers.id }).from(tripsTravelers).where(eq(tripsTravelers.id, travelerId)), "Traveller");
  const questions = await db().select().from(tripsQuizQuestions).where(eq(tripsQuizQuestions.quizId, quizId)).orderBy(asc(tripsQuizQuestions.sortOrder));
  if (questions.length === 0) throw new NotFound("Quiz");
  let score = 0;
  let total = 0;
  for (const q of questions) {
    total += q.points;
    if (answers[q.id] === q.answerIndex) score += q.points;
  }
  await db().insert(tripsQuizAttempts).values({ quizId, travelerId, score, totalPoints: total });
  return {
    score,
    total,
    review: questions.map((q) => ({ prompt: q.prompt, correct: q.choices[q.answerIndex], explanation: q.explanation, right: answers[q.id] === q.answerIndex })),
  };
}

export async function generateHuntFor(destinationId: string, minAge: number) {
  if (!(await aiConfigured())) throw new Error("Add a Gemini or Claude API key to generate hunts");
  const d = await destination(destinationId);
  const h = await generateHunt({ place: d.name, minAge });
  const [hunt] = await db().insert(tripsHunts).values({ tripId: d.tripId, destinationId: d.id, title: h.title }).returning();
  if (h.tasks.length) {
    await db()
      .insert(tripsHuntTasks)
      .values(h.tasks.map((t, i) => ({ huntId: hunt.id, prompt: t.prompt, hint: t.hint, points: Math.min(50, Math.max(1, t.points)), sortOrder: i })));
  }
}

export async function toggleHuntTask(taskId: string, travelerId: string) {
  const where = and(eq(tripsHuntCompletions.taskId, taskId), eq(tripsHuntCompletions.travelerId, travelerId));
  const existing = await db().select({ id: tripsHuntCompletions.id }).from(tripsHuntCompletions).where(where);
  if (existing.length) await db().delete(tripsHuntCompletions).where(where);
  else await db().insert(tripsHuntCompletions).values({ taskId, travelerId });
}

// ---------------------------------------------------------------------------
// Emergency info
// ---------------------------------------------------------------------------

export async function emergencyForTrip(tripId: string) {
  return db()
    .select({ info: tripsEmergencyInfo, destinationId: tripsDestinations.id })
    .from(tripsEmergencyInfo)
    .innerJoin(tripsDestinations, eq(tripsDestinations.id, tripsEmergencyInfo.destinationId))
    .where(eq(tripsDestinations.tripId, tripId));
}

export async function saveEmergencyInfo(
  destinationId: string,
  input: { emergencyNumber: string | null; hospitals: EmergencyEntry[]; pharmacies: EmergencyEntry[]; embassies: EmergencyEntry[]; gfGroceries: EmergencyEntry[]; notes: string | null },
) {
  await destination(destinationId);
  await db()
    .insert(tripsEmergencyInfo)
    .values({ destinationId, ...input })
    .onConflictDoUpdate({ target: tripsEmergencyInfo.destinationId, set: { ...input, updatedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Documents vault
// ---------------------------------------------------------------------------

/** Postgres bytea is no place for huge scans; keep uploads reasonable. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** List view: never selects the encrypted payload. */
export async function listDocuments() {
  return db()
    .select({
      id: tripsDocuments.id,
      tripId: tripsDocuments.tripId,
      travelerId: tripsDocuments.travelerId,
      itineraryItemId: tripsDocuments.itineraryItemId,
      kind: tripsDocuments.kind,
      title: tripsDocuments.title,
      filename: tripsDocuments.filename,
      sizeBytes: tripsDocuments.sizeBytes,
      hasFile: sql<boolean>`${tripsDocuments.cipherText} is not null`,
      documentNumberLast4: tripsDocuments.documentNumberLast4,
      expiresOn: tripsDocuments.expiresOn,
      issuingCountry: tripsDocuments.issuingCountry,
      notes: tripsDocuments.notes,
      uploadedBy: tripsDocuments.uploadedBy,
      createdAt: tripsDocuments.createdAt,
    })
    .from(tripsDocuments)
    .orderBy(asc(tripsDocuments.kind), asc(tripsDocuments.title));
}

export async function addDocument(
  input: {
    title: string;
    kind: (typeof DOCUMENT_KINDS)[number];
    tripId: string | null;
    travelerId: string | null;
    itineraryItemId: string | null;
    documentNumber: string | null;
    expiresOn: string | null;
    issuingCountry: string | null;
    notes: string | null;
    file: { name: string; type: string; bytes: Buffer } | null;
  },
  uploadedBy: string,
) {
  if (input.file && !vaultConfigured()) throw new Error("Set DOC_VAULT_KEY before uploading files. Details-only entries work without it.");
  if (input.file && input.file.bytes.length > MAX_DOCUMENT_BYTES) throw new Error("That file is larger than 8 MB. Store a compressed scan instead.");
  // Encrypt before it ever touches the database.
  const sealed = input.file ? sealBytes(input.file.bytes) : null;
  const number = input.documentNumber?.replace(/\s+/g, "") ?? "";
  await db().insert(tripsDocuments).values({
    title: input.title,
    kind: input.kind,
    tripId: input.tripId,
    travelerId: input.travelerId,
    itineraryItemId: input.itineraryItemId,
    uploadedBy,
    filename: input.file?.name ?? null,
    mimeType: input.file ? input.file.type || "application/octet-stream" : null,
    sizeBytes: input.file?.bytes.length ?? null,
    cipherText: sealed?.cipherText ?? null,
    iv: sealed?.iv ?? null,
    authTag: sealed?.authTag ?? null,
    // Only the last four characters are kept in the clear.
    documentNumberLast4: number ? number.slice(-4) : null,
    expiresOn: input.expiresOn,
    issuingCountry: input.issuingCountry,
    notes: input.notes,
  });
}

/** Decrypt one document for the signed-in user who asked for it. */
export async function openDocument(id: string) {
  const doc = await one(db().select().from(tripsDocuments).where(eq(tripsDocuments.id, id)), "Document");
  if (!doc.cipherText || !doc.iv || !doc.authTag) throw new Error("This entry has no file attached");
  const bytes = openBytes({ cipherText: Buffer.from(doc.cipherText), iv: Buffer.from(doc.iv), authTag: Buffer.from(doc.authTag) });
  return { filename: doc.filename ?? "document", mimeType: doc.mimeType ?? "application/octet-stream", base64: bytes.toString("base64") };
}

export async function deleteDocument(id: string) {
  await db().delete(tripsDocuments).where(eq(tripsDocuments.id, id));
}

/** Documents expiring on or before a date (passports need six months' validity for much of the world). */
export async function expiringDocuments(before: string) {
  return db()
    .select({ id: tripsDocuments.id, title: tripsDocuments.title, kind: tripsDocuments.kind, expiresOn: tripsDocuments.expiresOn })
    .from(tripsDocuments)
    .where(and(sql`${tripsDocuments.expiresOn} is not null`, lte(tripsDocuments.expiresOn, before)))
    .orderBy(asc(tripsDocuments.expiresOn));
}
