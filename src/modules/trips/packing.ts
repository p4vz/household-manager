import type { PackingCategory } from "./schema";

/** Pure packing-list transforms, shared by the API and the tests. */

export type TemplateItem = { name: string; category: PackingCategory; quantity: number; perPerson: boolean; notes: string | null };
export type ListItem = { name: string; category: PackingCategory; quantity: number; notes: string | null; travelerId: string | null };

/**
 * Expands a reusable template for a trip: per-person items become one line
 * per traveller so everyone gets their own checkbox; shared items appear
 * once with no owner. Ticking things off later never touches the template.
 */
export function expandTemplate(items: TemplateItem[], travelerIds: string[]): ListItem[] {
  return items.flatMap((i): ListItem[] =>
    i.perPerson
      ? travelerIds.map((travelerId) => ({ name: i.name, category: i.category, quantity: i.quantity, notes: i.notes, travelerId }))
      : [{ name: i.name, category: i.category, quantity: i.quantity, notes: i.notes, travelerId: null }],
  );
}

/** Collapses a finished trip list back into one line per item, for a new template. */
export function collapseToTemplate(items: ListItem[]): TemplateItem[] {
  const seen = new Map<string, TemplateItem>();
  for (const i of items) {
    const key = `${i.name.trim().toLowerCase()}|${i.category}`;
    const existing = seen.get(key);
    if (existing) existing.perPerson ||= i.travelerId !== null;
    else seen.set(key, { name: i.name.trim(), category: i.category, quantity: i.quantity, perPerson: i.travelerId !== null, notes: i.notes });
  }
  return [...seen.values()];
}
