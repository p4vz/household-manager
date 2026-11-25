import type { ShoppingBoard, ShoppingList, ShoppingSection } from "../shopping";
import { isDeferred, itemKey, nudge, placeAt } from "../shopping-core";

/**
 * Optimistic edits to the shopping board on the screen, applied the moment a
 * tile is tapped or dropped. The server's answer replaces the board right
 * after, so these only need to be close, not exact.
 */

export type { ShoppingBoard, ShoppingList, ShoppingSection };
export { itemKey, nudge, placeAt };

function mapSections(b: ShoppingBoard, fn: (s: ShoppingSection, list: ShoppingList) => ShoppingSection): ShoppingBoard {
  const each = (l: ShoppingList) => ({ ...l, sections: l.sections.map((s) => fn(s, l)) });
  return { ...b, lists: b.lists.map(each), deferred: b.deferred.map(each) };
}

export function allLists(b: ShoppingBoard): ShoppingList[] {
  return [...b.lists, ...b.deferred];
}

export function sectionOfItem(b: ShoppingBoard, itemId: string): ShoppingSection | undefined {
  for (const l of allLists(b)) for (const s of l.sections) if (s.items.some((i) => i.id === itemId)) return s;
  return undefined;
}

/** Ticking ticks the same item on every active list; un-ticking here touches only the one tapped (the server sorts out the rest). */
export function toggleItem(b: ShoppingBoard, itemId: string, checked: boolean): ShoppingBoard {
  const item = allLists(b)
    .flatMap((l) => l.sections.flatMap((s) => s.items))
    .find((i) => i.id === itemId);
  if (!item) return b;
  const key = itemKey(item.name);
  const active = new Set(b.lists.map((l) => l.id));
  return mapSections(b, (s, l) => ({
    ...s,
    items: s.items.map((i) => (i.id === itemId || (checked && active.has(l.id) && !i.checked && itemKey(i.name) === key) ? { ...i, checked } : i)),
  }));
}

export function addItem(b: ShoppingBoard, input: { name: string; store: string; listId: string }, tempId: string): ShoppingBoard {
  return {
    ...b,
    lists: b.lists.map((l) => {
      if (l.id !== input.listId) return l;
      const has = l.sections.find((s) => s.store.toLowerCase() === input.store.toLowerCase());
      const sections = has ? l.sections : [...l.sections, { id: `tmp-${tempId}`, store: input.store, items: [] }];
      return {
        ...l,
        sections: sections.map((s) => {
          if (s.store.toLowerCase() !== input.store.toLowerCase()) return s;
          const same = s.items.find((i) => itemKey(i.name) === itemKey(input.name));
          if (same) return { ...s, items: s.items.map((i) => (i === same ? { ...i, checked: false } : i)) };
          return { ...s, items: [...s.items, { id: tempId, name: input.name, quantity: null, checked: false }] };
        }),
      };
    }),
  };
}

/** Items still to buy come first, ticked ones after; `index` counts among the ones still to buy. */
export function moveItem(b: ShoppingBoard, itemId: string, toSectionId: string, index: number): ShoppingBoard {
  const from = sectionOfItem(b, itemId);
  const item = from?.items.find((i) => i.id === itemId);
  if (!from || !item) return b;
  return mapSections(b, (s) => {
    let items = s.items.filter((i) => i.id !== itemId);
    if (s.id === toSectionId) {
      const open = items.filter((i) => !i.checked);
      const done = items.filter((i) => i.checked);
      if (item.checked) items = [...open, ...done, item];
      else {
        const at = Math.max(0, Math.min(open.length, index));
        items = [...open.slice(0, at), item, ...open.slice(at), ...done];
      }
    }
    return { ...s, items };
  });
}

export function orderStores(b: ShoppingBoard, listId: string, sectionIds: string[]): ShoppingBoard {
  const each = (l: ShoppingList) =>
    l.id !== listId ? l : { ...l, sections: sectionIds.map((id) => l.sections.find((s) => s.id === id)!).filter(Boolean) };
  return { ...b, lists: b.lists.map(each), deferred: b.deferred.map(each) };
}

export function orderLists(b: ShoppingBoard, ids: string[]): ShoppingBoard {
  return { ...b, lists: ids.map((id) => b.lists.find((l) => l.id === id)!).filter(Boolean) };
}

export function deferLocal(b: ShoppingBoard, listId: string, until: string | null, today: string): ShoppingBoard {
  const lists = allLists(b).map((l) => (l.id === listId ? { ...l, deferredUntil: until } : l));
  return { ...b, lists: lists.filter((l) => !isDeferred(l.deferredUntil, today)), deferred: lists.filter((l) => isDeferred(l.deferredUntil, today)) };
}

export function removeLocal(b: ShoppingBoard, what: { itemId?: string; sectionId?: string; listId?: string }): ShoppingBoard {
  const keepList = (l: ShoppingList) => l.id !== what.listId;
  const each = (l: ShoppingList) => ({
    ...l,
    sections: l.sections.filter((s) => s.id !== what.sectionId).map((s) => ({ ...s, items: s.items.filter((i) => i.id !== what.itemId) })),
  });
  return { ...b, lists: b.lists.filter(keepList).map(each), deferred: b.deferred.filter(keepList).map(each) };
}

export function openCount(s: { items: { checked: boolean }[] }): number {
  return s.items.filter((i) => !i.checked).length;
}

/** YYYY-MM-DD plus `n` days. */
export function plusDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Tue, Dec 1". */
export function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
}
