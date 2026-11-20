import type { BookingStatus, ItineraryKind } from "./schema";

/**
 * Turns itinerary steps into the planned purchases finance's card planner
 * understands. Pure code so it can be tested without a database.
 *
 * Card bonus rules match on the household's own transaction categories
 * (Simplifi's defaults), and on merchant names, so each kind maps to the
 * category a charge of that kind would land in, and the booking provider
 * ("United", "Marriott") is passed as the merchant.
 */
export const KIND_CATEGORY: Record<ItineraryKind, { category: string; subcategory: string | null } | null> = {
  flight: { category: "Travel", subcategory: "Air Travel" },
  lodging: { category: "Travel", subcategory: "Hotel" },
  drive: { category: "Travel", subcategory: "Rental Car & Taxi" },
  train: { category: "Travel", subcategory: "Public Transportation" },
  ferry: { category: "Travel", subcategory: "Public Transportation" },
  activity: { category: "Entertainment", subcategory: null },
  meal: { category: "Food & Dining", subcategory: "Restaurants" },
  meeting: null,
  note: null,
};

export type PlannableItem = {
  id: string;
  kind: ItineraryKind;
  title: string;
  provider: string | null;
  cost: number | null;
  bookingStatus: BookingStatus;
  paidWithAccountId: string | null;
  chargeDate: string | null;
  bookingOpensOn: string | null;
};

export type PlannedPurchaseInput = {
  ref: string;
  date: string;
  amount: number;
  merchant: string;
  category: string | null;
  subcategory: string | null;
};

/** Not yet paid for, has a cost, and is the kind of thing a card is used for. */
export function isPlannable(item: PlannableItem): boolean {
  return (
    item.cost != null &&
    item.cost > 0 &&
    item.paidWithAccountId == null &&
    item.bookingStatus !== "cancelled" &&
    KIND_CATEGORY[item.kind] != null
  );
}

/**
 * When the charge will post: the date given on the step, else the day sales
 * open if that is still ahead, else today (book now).
 */
export function expectedChargeDate(item: PlannableItem, today: string): string {
  if (item.chargeDate) return item.chargeDate < today ? today : item.chargeDate;
  if (item.bookingOpensOn && item.bookingOpensOn > today) return item.bookingOpensOn;
  return today;
}

export function toPlannedPurchases(items: PlannableItem[], today: string): PlannedPurchaseInput[] {
  return items.filter(isPlannable).map((i) => {
    const cat = KIND_CATEGORY[i.kind]!;
    return {
      ref: i.id,
      date: expectedChargeDate(i, today),
      amount: i.cost!,
      merchant: i.provider?.trim() || i.title,
      category: cat.category,
      subcategory: cat.subcategory,
    };
  });
}

/** Planned trip total: the budget if set, else the sum of non-cancelled step costs. */
export function tripTotal(budget: number | null, items: { cost: number | null; bookingStatus: BookingStatus }[]): number | null {
  if (budget != null) return budget;
  const costs = items.filter((i) => i.bookingStatus !== "cancelled" && i.cost != null).map((i) => i.cost!);
  return costs.length ? Math.round(costs.reduce((s, c) => s + c, 0) * 100) / 100 : null;
}
