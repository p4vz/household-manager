import "server-only";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/core/db/client";
import * as finance from "@/modules/finance/api";
import type { Viewer } from "@/modules/finance/api";
import { tripsDestinations, tripsItineraryItems, tripsTrips } from "./schema";
import { addDays, autoLinks, searchRange, suggestForTrip, tripSpendSummary, type LinkedCharge, type SpendStep, type SpendTrip, type SpendTxn } from "./spend";

/**
 * Trips <-> expenses. Charges are tied to trips through finance's link
 * table (module "trips", target = trip id, detail = itinerary step id), so
 * every read goes through finance's privacy rule: a member sees only charges
 * on joint accounts and their own, and trip totals count only those.
 */

export const LINK_MODULE = "trips";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function toTxn(t: finance.LinkableTransaction): SpendTxn {
  return {
    id: t.id,
    date: t.date,
    merchant: t.merchant,
    description: t.description,
    amount: t.amount,
    category: t.category,
    subcategory: t.subcategory,
    link: t.link,
  };
}

async function loadTrip(tripId: string) {
  const [trip] = await db().select().from(tripsTrips).where(eq(tripsTrips.id, tripId));
  if (!trip) throw new Error("Trip not found");
  const [destinations, items] = await Promise.all([
    db().select({ name: tripsDestinations.name }).from(tripsDestinations).where(eq(tripsDestinations.tripId, tripId)),
    db().select().from(tripsItineraryItems).where(eq(tripsItineraryItems.tripId, tripId)).orderBy(asc(tripsItineraryItems.startsAt)),
  ]);
  return { trip, destinations, items };
}

function spendTrip(trip: typeof tripsTrips.$inferSelect, destinations: { name: string }[], items: (typeof tripsItineraryItems.$inferSelect)[]): SpendTrip {
  return {
    id: trip.id,
    startDate: trip.startDate,
    endDate: trip.endDate,
    budget: trip.budget,
    places: [...destinations.map((d) => d.name), ...items.map((i) => i.location ?? "").filter(Boolean)],
  };
}

const spendSteps = (items: (typeof tripsItineraryItems.$inferSelect)[]): SpendStep[] =>
  items.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    provider: i.provider,
    cost: i.cost,
    bookingStatus: i.bookingStatus,
    startsAt: i.startsAt,
    chargeDate: i.chargeDate,
  }));

/**
 * Everything about a trip's money for one member: plan vs actual, the
 * charges linked to it, suggested charges to add, things that look off
 * (missing bookings or charges), and what the charges earned in rewards.
 */
export async function tripSpend(viewer: Viewer, tripId: string, now = new Date()) {
  const { trip, destinations, items } = await loadTrip(tripId);
  const st = spendTrip(trip, destinations, items);
  const steps = spendSteps(items);
  const range = searchRange(st);
  const [linked, candidates] = await Promise.all([
    finance.linkedTransactions(viewer, LINK_MODULE, [tripId]),
    finance.linkCandidates(viewer, LINK_MODULE, range),
  ]);
  const stepIds = new Set(items.map((i) => i.id));
  const charges: (LinkedCharge & { accountId: string; owner: string; pending: boolean })[] = linked.map((t) => ({
    ...toTxn(t),
    // A step deleted since the charge was tied to it: the charge stays on the trip.
    link: t.link && { ...t.link, detailId: t.link.detailId && stepIds.has(t.link.detailId) ? t.link.detailId : null },
    account: t.account,
    accountId: t.accountId,
    owner: t.owner,
    pending: t.pending,
  }));
  const summary = tripSpendSummary(st, steps, charges, isoDay(now));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const suggestions = suggestForTrip(st, steps, candidates.map(toTxn)).map((s) => {
    const t = byId.get(s.transactionId)!;
    return { ...s, date: t.date, merchant: t.merchant, amount: t.amount, category: t.category, subcategory: t.subcategory, account: t.account, owner: t.owner };
  });
  const firstDate = charges.reduce((m, c) => (c.date < m ? c.date : m), trip.startDate);
  const rewards = await finance.rewardsForTransactions(viewer, charges.map((c) => c.id), firstDate);
  const stepTitle = new Map(items.map((i) => [i.id, i.title]));
  return {
    trip: { id: trip.id, name: trip.name, slug: trip.slug, startDate: trip.startDate, endDate: trip.endDate, status: trip.status },
    ...summary,
    charges: charges
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((c) => ({ ...c, step: c.link?.detailId ? (stepTitle.get(c.link.detailId) ?? null) : null, source: linked.find((l) => l.id === c.id)?.link?.source ?? null })),
    suggestions,
    rewards,
  };
}

export type TripSpend = Awaited<ReturnType<typeof tripSpend>>;

async function assertStep(tripId: string, stepId: string | null) {
  if (!stepId) return;
  const [row] = await db()
    .select({ id: tripsItineraryItems.id })
    .from(tripsItineraryItems)
    .where(and(eq(tripsItineraryItems.id, stepId), eq(tripsItineraryItems.tripId, tripId)));
  if (!row) throw new Error("That itinerary step is not on this trip");
}

async function assertTrip(tripId: string) {
  const [row] = await db().select({ id: tripsTrips.id }).from(tripsTrips).where(eq(tripsTrips.id, tripId));
  if (!row) throw new Error("Trip not found");
}

/** Ties charges to a trip (and optionally one step). Replaces any trip link they had. */
export async function linkTripCharges(
  viewer: Viewer,
  tripId: string,
  transactionIds: string[],
  opts: { stepId?: string | null; source?: "manual" | "assistant" } = {},
) {
  await assertTrip(tripId);
  await assertStep(tripId, opts.stepId ?? null);
  await finance.setTransactionLinks(viewer, LINK_MODULE, transactionIds, {
    targetId: tripId,
    detailId: opts.stepId ?? null,
    status: "linked",
    source: opts.source ?? "manual",
  });
}

/** "Not this trip": never suggested or auto-linked for it again. */
export async function dismissTripCharges(viewer: Viewer, tripId: string, transactionIds: string[], source: "manual" | "assistant" = "manual") {
  await assertTrip(tripId);
  await finance.setTransactionLinks(viewer, LINK_MODULE, transactionIds, { targetId: tripId, detailId: null, status: "dismissed", source });
}

/** Takes charges off whatever trip they were on, back to unreviewed. */
export async function unlinkTripCharges(viewer: Viewer, transactionIds: string[]) {
  await finance.clearTransactionLinks(viewer, LINK_MODULE, transactionIds);
}

/** The trip link on one charge, for undo. Null if none or not visible. */
export async function tripChargeLink(viewer: Viewer, transactionId: string) {
  const [t] = await finance.transactionsWithLinks(viewer, LINK_MODULE, [transactionId]);
  if (!t) return undefined;
  return { label: `${t.date} ${t.merchant} ${t.amount < 0 ? "-" : ""}$${Math.abs(t.amount).toFixed(2)}`, link: t.link };
}

/** Trip names by id, for labels. */
export async function tripNames(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db().select({ id: tripsTrips.id, name: tripsTrips.name }).from(tripsTrips).where(inArray(tripsTrips.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Background matching after each bank sync or CSV import: links strong
 * matches (same company as a booked step at about its cost, or charged in a
 * trip town during the trip) for trips that ended in the last 60 days or are
 * coming up. Never touches a link a person made or dismissed.
 */
export async function autoLinkTripCharges(now = new Date()) {
  const today = isoDay(now);
  const trips = await db()
    .select()
    .from(tripsTrips)
    .where(and(eq(tripsTrips.status, "planned"), gte(tripsTrips.endDate, addDays(today, -60)), lte(tripsTrips.startDate, addDays(today, 365))));
  if (!trips.length) return 0;
  const loaded = await Promise.all(trips.map((t) => loadTrip(t.id)));
  const plans = loaded.map(({ trip, destinations, items }) => ({ trip: spendTrip(trip, destinations, items), steps: spendSteps(items) }));
  const from = plans.map((p) => searchRange(p.trip).from).sort()[0];
  const to = plans.map((p) => searchRange(p.trip).to).sort().at(-1)!;
  const txns = await finance.householdLinkCandidates(LINK_MODULE, { from, to });
  return finance.autoLinkTransactions(LINK_MODULE, autoLinks(plans, txns.map(toTxn)));
}

/** Slug and step title for a stored link, for readable change lists. */
export async function tripLinkInfo(tripId: string, stepId: string | null) {
  const [trip] = await db().select({ slug: tripsTrips.slug }).from(tripsTrips).where(eq(tripsTrips.id, tripId));
  let step: string | null = null;
  if (stepId) {
    const [row] = await db().select({ title: tripsItineraryItems.title }).from(tripsItineraryItems).where(eq(tripsItineraryItems.id, stepId));
    step = row?.title ?? null;
  }
  return { slug: trip?.slug ?? null, step };
}

/** Trip by slug and, optionally, one of its steps by title (or id). */
export async function resolveTripStep(slug: string, step: string | null) {
  const [trip] = await db().select({ id: tripsTrips.id }).from(tripsTrips).where(eq(tripsTrips.slug, slug));
  if (!trip) throw new Error(`No trip "${slug}". Use the trip value from list_trips.`);
  if (!step) return { tripId: trip.id, stepId: null };
  const items = await db()
    .select({ id: tripsItineraryItems.id, title: tripsItineraryItems.title })
    .from(tripsItineraryItems)
    .where(eq(tripsItineraryItems.tripId, trip.id));
  const want = step.trim().toLowerCase();
  const hit = items.find((i) => i.id === step) ?? items.find((i) => i.title.trim().toLowerCase() === want);
  if (!hit) throw new Error(`No itinerary step "${step}" on that trip.`);
  return { tripId: trip.id, stepId: hit.id };
}
