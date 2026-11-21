/**
 * How catalog categories ("dining", "flights") map onto the household's own
 * transaction categories, which come from Quicken Simplifi
 * ("Food & Dining" / "Restaurants") or the AI categorizer. Pure.
 *
 * One catalog multiplier becomes one engine rule per matcher; they share a
 * cap group, so a "$1,500 per quarter" cap is counted once across them.
 */
import type { CardRule } from "../engine";
import { CATALOG_CATEGORIES, quarterBounds, type CardTerms, type CatalogCategory } from "./terms";

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

/**
 * Kinds of purchase an assistant can ask about ("which card for a hotel?"),
 * and the household category a charge of that kind lands in. Each pair is
 * one the matchers above recognise, so card rules and catalog multipliers
 * both apply. Travel kinds match trips' itinerary mapping.
 */
export const PURCHASE_KINDS = [...CATALOG_CATEGORIES, "other"] as const;
export type PurchaseKind = (typeof PURCHASE_KINDS)[number];

export const PURCHASE_CATEGORY: Record<PurchaseKind, { category: string | null; subcategory: string | null }> = {
  dining: { category: "Food & Dining", subcategory: "Restaurants" },
  groceries: { category: "Food & Dining", subcategory: "Groceries" },
  gas: { category: "Auto & Transport", subcategory: "Gas & Fuel" },
  ev_charging: { category: "Auto & Transport", subcategory: "EV Charging" },
  travel: { category: "Travel", subcategory: null },
  flights: { category: "Travel", subcategory: "Air Travel" },
  hotels: { category: "Travel", subcategory: "Hotel" },
  car_rental: { category: "Travel", subcategory: "Rental Car & Taxi" },
  transit: { category: "Travel", subcategory: "Public Transportation" },
  streaming: { category: "Entertainment", subcategory: "Streaming" },
  entertainment: { category: "Entertainment", subcategory: null },
  drugstores: { category: "Health & Fitness", subcategory: "Pharmacy" },
  home_improvement: { category: "Home", subcategory: "Home Improvement" },
  utilities: { category: "Bills & Utilities", subcategory: null },
  online_shopping: { category: "Shopping", subcategory: "Online Shopping" },
  other: { category: null, subcategory: null },
};
