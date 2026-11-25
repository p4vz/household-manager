import type { BookingStatus, ItineraryKind } from "./schema";

/**
 * Trip spending: which bank charges belong to a trip, and how they compare
 * with the plan. Pure code (no database), so the rules can be tested.
 *
 * A charge is matched to a trip by:
 * - the company on an itinerary step ("Marriott" on the lodging step and
 *   "MARRIOTT POCONO" on the card), checked against the step's cost;
 * - the place: charged during the trip in a town the trip visits;
 * - the kind of spending during the trip (restaurants, gas, travel), which
 *   is only a suggestion for a person or Claude to confirm.
 *
 * Only "strong" matches are linked without asking; everything else is a
 * suggestion. A charge a person marked "not this trip" is never suggested
 * for it again.
 */

export type SpendTrip = {
  id: string;
  startDate: string;
  endDate: string;
  budget: number | null;
  /** Place names: destinations and step locations. */
  places: string[];
};

export type SpendStep = {
  id: string;
  kind: ItineraryKind;
  title: string;
  provider: string | null;
  cost: number | null;
  bookingStatus: BookingStatus;
  startsAt: Date;
  chargeDate: string | null;
};

export type SpendTxn = {
  id: string;
  date: string;
  merchant: string;
  description: string;
  /** Negative = money out. */
  amount: number;
  category: string | null;
  subcategory: string | null;
  link: { targetId: string; detailId: string | null; status: "linked" | "dismissed" } | null;
};

export type Confidence = "strong" | "possible";

export type Suggestion = {
  transactionId: string;
  confidence: Confidence;
  stepId: string | null;
  reason: string;
};

/** Charges post a few days late, and a trip often starts with a fuel stop the day before. */
export const WINDOW_BEFORE_DAYS = 1;
export const WINDOW_AFTER_DAYS = 3;
/** How far back a booking with the same company can be. */
export const BOOKING_LOOKBACK_DAYS = 365;
/** Travel-category charges this long before the trip are offered as possible bookings. */
export const TRAVEL_LOOKBACK_DAYS = 180;
/** A booking charge within this share of the step's cost counts as that step. */
export const COST_TOLERANCE = 0.15;

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** First and last dates worth searching for a trip's charges. */
export function searchRange(trip: Pick<SpendTrip, "startDate" | "endDate">) {
  return { from: addDays(trip.startDate, -BOOKING_LOOKBACK_DAYS), to: addDays(trip.endDate, WINDOW_AFTER_DAYS) };
}

export function inTripWindow(trip: Pick<SpendTrip, "startDate" | "endDate">, date: string) {
  return date >= addDays(trip.startDate, -WINDOW_BEFORE_DAYS) && date <= addDays(trip.endDate, WINDOW_AFTER_DAYS);
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** Words that say nothing about which company or town it is. */
const GENERIC = new Set(
  (
    "the a an and of at by in on to for co inc llc ltd corp com www " +
    "hotel hotels resort resorts inn suites lodge motel airlines airline airways air lines rental rentals car cars " +
    "travel tours tour trip great grand royal golden best new old north south east west upper lower " +
    "city town village county state park beach lake lakes mountain mountains island islands valley river " +
    "saint san santa port fort mount mt international national usa us america american"
  ).split(" "),
);

/** "American Airlines" is a company; "American" alone would match far too much. */
const KEEP_IF_FIRST = new Set(["american", "national", "united"]);

function hit(token: string, textWords: string[]): boolean {
  return textWords.some((w) => w === token || (token.length >= 4 && w.length >= 4 && (w.startsWith(token) || token.startsWith(w))));
}

/** The distinctive word of a company name: "Hampton Inn by Hilton" -> "hampton". */
export function providerKey(provider: string | null): string | null {
  if (!provider) return null;
  const ws = words(provider);
  if (ws.length && KEEP_IF_FIRST.has(ws[0]) && ws.length > 1) return ws[0];
  return ws.find((w) => w.length >= 3 && !GENERIC.has(w)) ?? null;
}

/** Distinctive words of the trip's places, for "charged in <town>". */
export function placeKeys(places: string[]): string[] {
  const out = new Set<string>();
  for (const p of places) {
    for (const w of words(p.split(",")[0] ?? "")) if (w.length >= 5 && !GENERIC.has(w)) out.add(w);
  }
  return [...out];
}

const TRIP_CATEGORIES = /^(travel|food|restaurant|dining|gas|fuel|auto|entertainment|fast food|coffee|parking|lodging|hotel|air)/i;
const BOOKING_SUBCATEGORIES = /(air|hotel|lodging|rental car|vacation)/i;

function categoryOf(t: SpendTxn) {
  return [t.category, t.subcategory].filter(Boolean).join(" / ");
}

function looksLikeTripSpend(t: SpendTxn) {
  return TRIP_CATEGORIES.test(t.category ?? "") || TRIP_CATEGORIES.test(t.subcategory ?? "");
}

function looksLikeBooking(t: SpendTxn) {
  return /^travel/i.test(t.category ?? "") && BOOKING_SUBCATEGORIES.test(`${t.subcategory ?? ""} ${t.category ?? ""}`);
}

function closeTo(cost: number | null, amount: number) {
  if (cost == null || cost <= 0) return false;
  return Math.abs(Math.abs(amount) - cost) <= cost * COST_TOLERANCE;
}

/**
 * Suggestions for one trip over `txns` (any order). Transactions already
 * linked to any trip, or dismissed for this one, are left out.
 */
export function suggestForTrip(trip: SpendTrip, steps: SpendStep[], txns: SpendTxn[]): Suggestion[] {
  const range = searchRange(trip);
  const places = placeKeys(trip.places);
  const providers = steps
    .filter((s) => s.bookingStatus !== "cancelled")
    .map((s) => ({ step: s, key: providerKey(s.provider) }))
    .filter((p): p is { step: SpendStep; key: string } => p.key != null);
  const out: Suggestion[] = [];

  for (const t of txns) {
    if (t.link && (t.link.status === "linked" || t.link.targetId === trip.id)) continue;
    if (t.amount === 0 || t.date < range.from || t.date > range.to) continue;
    const text = words(`${t.merchant} ${t.description}`);
    const during = inTripWindow(trip, t.date);

    // 1. Same company as a step: the best evidence there is.
    const byProvider = providers.filter((p) => hit(p.key, text));
    if (byProvider.length) {
      const best = byProvider.find((p) => closeTo(p.step.cost, t.amount)) ?? byProvider[0];
      const priced = closeTo(best.step.cost, t.amount);
      const name = best.step.provider ?? best.step.title;
      if (priced || during || t.amount > 0) {
        out.push({
          transactionId: t.id,
          confidence: "strong",
          stepId: best.step.id,
          reason: t.amount > 0 ? `refund from ${name}` : priced ? `${name}, about the planned cost` : `${name}, during the trip`,
        });
      } else if (t.date <= addDays(trip.endDate, WINDOW_AFTER_DAYS)) {
        out.push({ transactionId: t.id, confidence: "possible", stepId: best.step.id, reason: `same company as "${best.step.title}", but a different amount` });
      }
      continue;
    }

    if (during) {
      // 2. Charged in a town the trip visits.
      const place = places.find((p) => hit(p, text));
      if (place) {
        out.push({ transactionId: t.id, confidence: "strong", stepId: null, reason: `charged in ${place[0].toUpperCase()}${place.slice(1)} during the trip` });
        continue;
      }
      // 3. Trip-like spending during the trip.
      if (looksLikeTripSpend(t)) {
        out.push({ transactionId: t.id, confidence: "possible", stepId: null, reason: `${categoryOf(t) || "spending"} during the trip` });
      }
      continue;
    }

    // 4. A travel booking in the months before the trip.
    if (t.amount < 0 && t.date < trip.startDate && t.date >= addDays(trip.startDate, -TRAVEL_LOOKBACK_DAYS) && looksLikeBooking(t)) {
      out.push({ transactionId: t.id, confidence: "possible", stepId: null, reason: `${categoryOf(t)} booked before the trip` });
    }
  }
  return out;
}

/**
 * Strong matches to link automatically across several trips. A charge that
 * is a strong match for more than one trip (overlapping dates) is left for
 * a person to decide.
 */
export function autoLinks(trips: { trip: SpendTrip; steps: SpendStep[] }[], txns: SpendTxn[]) {
  const byTxn = new Map<string, { targetId: string; detailId: string | null }[]>();
  for (const { trip, steps } of trips) {
    for (const s of suggestForTrip(trip, steps, txns)) {
      if (s.confidence !== "strong") continue;
      const list = byTxn.get(s.transactionId) ?? [];
      list.push({ targetId: trip.id, detailId: s.stepId });
      byTxn.set(s.transactionId, list);
    }
  }
  return [...byTxn.entries()].filter(([, l]) => l.length === 1).map(([transactionId, [l]]) => ({ transactionId, ...l }));
}

// ---------------------------------------------------------------------------
// Plan vs actual
// ---------------------------------------------------------------------------

export type LinkedCharge = SpendTxn & { account: string };

export type SpendFlag =
  | { kind: "no_charge"; stepId: string; message: string }
  | { kind: "charged_not_booked"; stepId: string; message: string }
  | { kind: "cost_differs"; stepId: string; message: string }
  | { kind: "charge_without_step"; transactionId: string; message: string }
  | { kind: "over_plan"; message: string };

const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** The planned total: the budget, else the sum of non-cancelled step costs. */
export function plannedTotal(budget: number | null, steps: Pick<SpendStep, "cost" | "bookingStatus">[]): number | null {
  if (budget != null) return budget;
  const costs = steps.filter((s) => s.bookingStatus !== "cancelled" && s.cost != null).map((s) => s.cost!);
  return costs.length ? r2(costs.reduce((a, b) => a + b, 0)) : null;
}

/**
 * Plan vs actual for a trip from the charges linked to it (only those the
 * member can see; the other member's private cards are not counted).
 */
export function tripSpendSummary(trip: SpendTrip, steps: SpendStep[], charges: LinkedCharge[], today: string) {
  const live = steps.filter((s) => s.bookingStatus !== "cancelled");
  const planned = plannedTotal(trip.budget, live);
  const spent = r2(charges.reduce((s, c) => s - c.amount, 0));
  const before = r2(charges.filter((c) => c.date < addDays(trip.startDate, -WINDOW_BEFORE_DAYS)).reduce((s, c) => s - c.amount, 0));

  const byCategory = new Map<string, number>();
  for (const c of charges) {
    const k = c.category ?? "Uncategorized";
    byCategory.set(k, (byCategory.get(k) ?? 0) - c.amount);
  }

  const chargesByStep = new Map<string, LinkedCharge[]>();
  for (const c of charges) {
    if (!c.link?.detailId) continue;
    chargesByStep.set(c.link.detailId, [...(chargesByStep.get(c.link.detailId) ?? []), c]);
  }

  const stepRows = live
    .filter((s) => s.cost != null || chargesByStep.has(s.id))
    .map((s) => {
      const mine = chargesByStep.get(s.id) ?? [];
      const actual = mine.length ? r2(mine.reduce((a, c) => a - c.amount, 0)) : null;
      return { id: s.id, kind: s.kind, title: s.title, provider: s.provider, planned: s.cost, actual, bookingStatus: s.bookingStatus, charges: mine.length };
    });

  const flags: SpendFlag[] = [];
  const tripStarted = trip.startDate <= today;
  for (const s of stepRows) {
    const step = live.find((x) => x.id === s.id)!;
    if (s.actual == null && (s.bookingStatus === "booked" || s.bookingStatus === "confirmed") && (s.planned ?? 0) > 0) {
      const due = step.chargeDate ? step.chargeDate <= addDays(today, -WINDOW_AFTER_DAYS) : tripStarted;
      if (due)
        flags.push({
          kind: "no_charge",
          stepId: s.id,
          message: `"${s.title}" is ${s.bookingStatus} but no charge is linked to it. It may be on a card you can't see, prepaid, or not posted yet.`,
        });
    }
    if (s.actual != null && s.actual > 0 && (s.bookingStatus === "idea" || s.bookingStatus === "needs_booking")) {
      flags.push({ kind: "charged_not_booked", stepId: s.id, message: `"${s.title}" has a ${usd(s.actual)} charge but is still marked "${s.bookingStatus.replace("_", " ")}".` });
    }
    if (s.actual != null && s.planned != null && s.planned > 0 && Math.abs(s.actual - s.planned) > Math.max(20, s.planned * 0.1)) {
      const diff = s.actual - s.planned;
      flags.push({ kind: "cost_differs", stepId: s.id, message: `"${s.title}" cost ${usd(s.actual)}, ${usd(diff)} ${diff > 0 ? "more" : "less"} than the ${usd(s.planned)} planned.` });
    }
  }
  for (const c of charges) {
    if (c.link?.detailId || c.amount >= 0 || !looksLikeBooking(c)) continue;
    flags.push({
      kind: "charge_without_step",
      transactionId: c.id,
      message: `${c.merchant} (${usd(c.amount)}, ${categoryOf(c)}) on ${c.date} isn't on the itinerary. Missing a booking?`,
    });
  }
  if (planned != null && spent > planned) flags.push({ kind: "over_plan", message: `Spent ${usd(spent)}, ${usd(spent - planned)} over the ${usd(planned)} planned.` });

  return {
    planned,
    spent,
    remaining: planned == null ? null : r2(planned - spent),
    spentBeforeTrip: before,
    byCategory: [...byCategory.entries()].map(([category, amount]) => ({ category, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
    steps: stepRows,
    flags,
  };
}
