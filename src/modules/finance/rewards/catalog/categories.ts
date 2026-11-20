/**
 * How catalog categories ("dining", "flights") map onto the household's own
 * transaction categories, which come from Quicken Simplifi
 * ("Food & Dining" / "Restaurants") or the AI categorizer. Pure.
 *
 * One catalog multiplier becomes one engine rule per matcher; they share a
 * cap group, so a "$1,500 per quarter" cap is counted once across them.
 */
import type { CardRule } from "../engine";
import { quarterBounds, type CardTerms, type CatalogCategory } from "./terms";

type Matcher = Pick<CardRule, "matchType" | "match">;

const sub = (...names: string[]): Matcher[] => names.map((match) => ({ matchType: "subcategory", match }));
const cat = (...names: string[]): Matcher[] => names.map((match) => ({ matchType: "category", match }));

export const CATEGORY_MATCHERS: Record<CatalogCategory, Matcher[]> = {
  dining: sub("Restaurants", "Fast Food", "Coffee Shops", "Food Delivery", "Bars", "Alcohol & Bars"),
  groceries: sub("Groceries", "Supermarkets"),
  gas: sub("Gas & Fuel", "Gas", "Fuel"),
  ev_charging: sub("EV Charging"),
  travel: cat("Travel"),
  flights: sub("Air Travel", "Airfare", "Flights"),
  hotels: sub("Hotel", "Hotels", "Lodging"),
  car_rental: sub("Rental Car & Taxi", "Car Rental"),
  transit: sub("Public Transportation", "Ride Share", "Rideshare", "Taxi", "Parking", "Tolls"),
  streaming: sub("Streaming", "Streaming Services", "Television", "Music"),
  entertainment: cat("Entertainment"),
  drugstores: sub("Pharmacy", "Drugstore"),
  home_improvement: sub("Home Improvement", "Hardware"),
  utilities: cat("Bills & Utilities"),
  online_shopping: sub("Online Shopping"),
};

export function matchersFor(on: string): Matcher[] {
  if (on.startsWith("merchant:")) return [{ matchType: "merchant", match: on.slice("merchant:".length).trim() }];
  return CATEGORY_MATCHERS[on as CatalogCategory] ?? [];
}

export type DerivedRule = Omit<CardRule, "id"> & { id: string };

/**
 * Engine rules for a catalog card's fixed multipliers. Ids are stable
 * (`<product>:<index>:<matcher>`) so the cap group is stable too.
 */
export function rulesFromTerms(productId: string, terms: CardTerms): DerivedRule[] {
  return terms.multipliers.flatMap((m, i) =>
    matchersFor(m.on).map((mt, j) => ({
      id: `${productId}:m${i}:${j}`,
      capGroup: m.capAmount != null ? `${productId}:m${i}` : undefined,
      matchType: mt.matchType,
      match: mt.match,
      rate: m.rate,
      capAmount: m.capAmount,
      capPeriod: m.capAmount != null ? (m.capPeriod ?? "year") : null,
      validFrom: null,
      validTo: null,
      label: m.note ? `${m.on} (${m.note})` : m.on,
    })),
  );
}

/** Rules for each known rotating quarter, valid only inside that quarter. */
export function rotatingRules(productId: string, terms: CardTerms): DerivedRule[] {
  const r = terms.rotating;
  if (!r) return [];
  return r.quarters.flatMap((q) => {
    const { from, to } = quarterBounds(q.quarter);
    return q.on.flatMap((on) =>
      matchersFor(on).map((mt, j) => ({
        id: `${productId}:${q.quarter}:${on}:${j}`,
        capGroup: r.capAmount != null ? `${productId}:${q.quarter}` : undefined,
        matchType: mt.matchType,
        match: mt.match,
        rate: r.rate,
        capAmount: r.capAmount,
        capPeriod: r.capAmount != null ? ("quarter" as const) : null,
        validFrom: from,
        validTo: to,
        label: `${q.quarter} rotating: ${q.description}`,
      })),
    );
  });
}
