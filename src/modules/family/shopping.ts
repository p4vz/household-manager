import "server-only";
import { and, asc, eq, inArray, isNotNull, lt, max, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { householdTimeZone } from "@/core/time/zoned";
import {
  familyShoppingItems,
  familyShoppingLists,
  familyShoppingRevision,
  familyShoppingSections,
  familyShoppingTemplateItems,
  familyShoppingTemplates,
} from "./schema";
import { BOUGHT_ITEM_TTL_MS, DEFAULT_STORES, isDeferred, itemKey, placeAt } from "./shopping-core";
import { householdToday } from "./time";

/**
 * Shopping lists. A list holds store sections, a section holds items. Lists
 * show one below the other; a list deferred until a date is hidden until
 * then. Ticking an item ticks the same item (by name, see itemKey) on every
 * active list. Templates start new lists; any list can be saved as one.
 *
 * Every change bumps one revision counter, so a screen can ask "anything new
 * since N?" every few seconds for the price of one row read.
 */

export type ShoppingItem = { id: string; name: string; quantity: string | null; checked: boolean };
export type ShoppingSection = { id: string; store: string; items: ShoppingItem[] };
export type ShoppingList = { id: string; name: string; deferredUntil: string | null; sections: ShoppingSection[] };
export type ShoppingTemplateStore = { store: string; items: { name: string; quantity: string | null }[] };
export type ShoppingTemplate = { id: string; name: string; stores: ShoppingTemplateStore[] };
export type ShoppingBoard = {
  revision: number;
  /** Lists to shop from now, in display order. */
  lists: ShoppingList[];
  /** Lists put off until a later date, soonest first. */
  deferred: ShoppingList[];
  templates: ShoppingTemplate[];
  /** Store names to suggest: the defaults, then every store used before. */
  stores: string[];
};

const clean = (s: string, n: number) => s.trim().replace(/\s+/g, " ").slice(0, n);
const cleanQty = (q: string | null | undefined) => (q ? clean(q, 20) || null : null);
const todayHere = (now: Date) => householdToday(now, householdTimeZone());

export class ShoppingNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "ShoppingNotFoundError";
  }
}

// ----------------------------------------------------------- revision ----

export async function shoppingRevision(): Promise<number> {
  const [row] = await db().select({ r: familyShoppingRevision.revision }).from(familyShoppingRevision).where(eq(familyShoppingRevision.id, 1));
  return row?.r ?? 0;
}

async function bump(): Promise<number> {
  const [row] = await db()
    .insert(familyShoppingRevision)
    .values({ id: 1, revision: 1 })
    .onConflictDoUpdate({ target: familyShoppingRevision.id, set: { revision: sql`${familyShoppingRevision.revision} + 1` } })
    .returning({ r: familyShoppingRevision.revision });
  return row.r;
}

// --------------------------------------------------------------- read ----

export async function shoppingBoard(now = new Date()): Promise<ShoppingBoard> {
  const today = todayHere(now);
  const [revision, lists, sections, items, templates] = await Promise.all([
    shoppingRevision(),
    db().select().from(familyShoppingLists).orderBy(asc(familyShoppingLists.sortOrder), asc(familyShoppingLists.createdAt)),
    db().select().from(familyShoppingSections).orderBy(asc(familyShoppingSections.sortOrder), asc(familyShoppingSections.store)),
    db().select().from(familyShoppingItems).orderBy(asc(familyShoppingItems.sortOrder), asc(familyShoppingItems.createdAt)),
    listTemplates(),
  ]);

  const itemsBySection = new Map<string, ShoppingItem[]>();
  for (const i of items) {
    const arr = itemsBySection.get(i.sectionId) ?? [];
    arr.push({ id: i.id, name: i.name, quantity: i.quantity, checked: i.checked });
    itemsBySection.set(i.sectionId, arr);
  }
  const sectionsByList = new Map<string, ShoppingSection[]>();
  for (const s of sections) {
    const arr = sectionsByList.get(s.listId) ?? [];
    arr.push({ id: s.id, store: s.store, items: itemsBySection.get(s.id) ?? [] });
    sectionsByList.set(s.listId, arr);
  }
  const views: ShoppingList[] = lists.map((l) => ({ id: l.id, name: l.name, deferredUntil: l.deferredUntil, sections: sectionsByList.get(l.id) ?? [] }));

  const used = new Set<string>([...sections.map((s) => s.store), ...templates.flatMap((t) => t.stores.map((s) => s.store))]);
  const defaults = DEFAULT_STORES as readonly string[];
  return {
    revision,
    lists: views.filter((l) => !isDeferred(l.deferredUntil, today)),
    deferred: views.filter((l) => isDeferred(l.deferredUntil, today)).sort((a, b) => a.deferredUntil!.localeCompare(b.deferredUntil!)),
    templates,
    stores: [...defaults, ...[...used].filter((s) => !defaults.includes(s)).sort((a, b) => a.localeCompare(b))],
  };
}

/** Items still to buy on active lists (for badges). */
export function openItemCount(board: Pick<ShoppingBoard, "lists">): number {
  return board.lists.reduce((n, l) => n + l.sections.reduce((m, s) => m + s.items.filter((i) => !i.checked).length, 0), 0);
}

/** Stores with something still to buy on active lists (the kiosk tab badge). */
export function openStoreCount(board: Pick<ShoppingBoard, "lists">): number {
  const stores = new Set<string>();
  for (const l of board.lists) for (const s of l.sections) if (s.items.some((i) => !i.checked)) stores.add(s.store.trim().toLowerCase());
  return stores.size;
}

/** Unticked items in one store across the active lists, for a printed slip. */
export function storeItemsToBuy(board: Pick<ShoppingBoard, "lists">, store: string): { name: string; quantity: string | null }[] {
  const seen = new Set<string>();
  const out: { name: string; quantity: string | null }[] = [];
  for (const l of board.lists)
    for (const s of l.sections)
      if (s.store === store)
        for (const i of s.items)
          if (!i.checked && !seen.has(itemKey(i.name))) {
            seen.add(itemKey(i.name));
            out.push({ name: i.name, quantity: i.quantity });
          }
  return out;
}

// -------------------------------------------------------------- lists ----

async function nextListOrder() {
  const [row] = await db().select({ m: max(familyShoppingLists.sortOrder) }).from(familyShoppingLists);
  return (row?.m ?? -1) + 1;
}

/** Creates a list at the bottom, optionally filled from a template. Returns its id. */
export async function createList(input: { name?: string; templateId?: string }): Promise<string> {
  let template: ShoppingTemplate | undefined;
  if (input.templateId) {
    template = (await listTemplates()).find((t) => t.id === input.templateId);
    if (!template) throw new ShoppingNotFoundError("Template");
  }
  const name = clean(input.name ?? template?.name ?? "", 60) || "Shopping";
  const [list] = await db()
    .insert(familyShoppingLists)
    .values({ name, sortOrder: await nextListOrder() })
    .returning({ id: familyShoppingLists.id });
  if (template) {
    for (const [si, s] of template.stores.entries()) {
      const [sec] = await db().insert(familyShoppingSections).values({ listId: list.id, store: s.store, sortOrder: si }).returning({ id: familyShoppingSections.id });
      if (s.items.length)
        await db()
          .insert(familyShoppingItems)
          .values(s.items.map((i, n) => ({ sectionId: sec.id, name: i.name, quantity: i.quantity, sortOrder: n })));
    }
  }
  await bump();
  return list.id;
}

export async function renameList(id: string, name: string) {
  const n = clean(name, 60);
  if (!n) return;
  await db().update(familyShoppingLists).set({ name: n }).where(eq(familyShoppingLists.id, id));
  await bump();
}

/** Deletes a list with its stores and items. */
export async function deleteList(id: string) {
  await db().delete(familyShoppingLists).where(eq(familyShoppingLists.id, id));
  await bump();
}

/** Hides a list until `until` (a household date, YYYY-MM-DD); null brings it back now. */
export async function deferList(id: string, until: string | null) {
  await db().update(familyShoppingLists).set({ deferredUntil: until }).where(eq(familyShoppingLists.id, id));
  await bump();
}

/** Sets the display order of lists. Ids not given keep their place after the given ones. */
export async function reorderLists(ids: string[]) {
  const all = await db().select({ id: familyShoppingLists.id }).from(familyShoppingLists).orderBy(asc(familyShoppingLists.sortOrder), asc(familyShoppingLists.createdAt));
  const order = [...ids.filter((id) => all.some((l) => l.id === id)), ...all.map((l) => l.id).filter((id) => !ids.includes(id))];
  for (const [n, id] of order.entries()) await db().update(familyShoppingLists).set({ sortOrder: n }).where(eq(familyShoppingLists.id, id));
  await bump();
}

// ------------------------------------------------------------- stores ----

async function sectionFor(listId: string, store: string): Promise<string> {
  const s = clean(store, 40);
  if (!s) throw new Error("Store is required");
  const [list] = await db().select({ id: familyShoppingLists.id }).from(familyShoppingLists).where(eq(familyShoppingLists.id, listId));
  if (!list) throw new ShoppingNotFoundError("List");
  const [existing] = await db()
    .select({ id: familyShoppingSections.id })
    .from(familyShoppingSections)
    .where(and(eq(familyShoppingSections.listId, listId), sql`lower(${familyShoppingSections.store}) = lower(${s})`));
  if (existing) return existing.id;
  const [row] = await db().select({ m: max(familyShoppingSections.sortOrder) }).from(familyShoppingSections).where(eq(familyShoppingSections.listId, listId));
  const [sec] = await db()
    .insert(familyShoppingSections)
    .values({ listId, store: s, sortOrder: (row?.m ?? -1) + 1 })
    .returning({ id: familyShoppingSections.id });
  return sec.id;
}

/** Adds a store section at the bottom of a list (or returns the one already there). */
export async function addStore(listId: string, store: string): Promise<string> {
  const id = await sectionFor(listId, store);
  await bump();
  return id;
}

/** Removes a store section and its items. */
export async function removeStore(sectionId: string) {
  await db().delete(familyShoppingSections).where(eq(familyShoppingSections.id, sectionId));
  await bump();
}

/** Sets the order of the store sections in a list. */
export async function reorderStores(listId: string, sectionIds: string[]) {
  const all = await db()
    .select({ id: familyShoppingSections.id })
    .from(familyShoppingSections)
    .where(eq(familyShoppingSections.listId, listId))
    .orderBy(asc(familyShoppingSections.sortOrder));
  const order = [...sectionIds.filter((id) => all.some((s) => s.id === id)), ...all.map((s) => s.id).filter((id) => !sectionIds.includes(id))];
  for (const [n, id] of order.entries()) await db().update(familyShoppingSections).set({ sortOrder: n }).where(eq(familyShoppingSections.id, id));
  await bump();
}

// -------------------------------------------------------------- items ----

/** The list a bare "add milk at Costco" goes to: the first active list, or a new "Shopping" list. */
async function defaultListId(now: Date): Promise<string> {
  const today = todayHere(now);
  const lists = await db().select().from(familyShoppingLists).orderBy(asc(familyShoppingLists.sortOrder), asc(familyShoppingLists.createdAt));
  const active = lists.find((l) => !isDeferred(l.deferredUntil, today));
  if (active) return active.id;
  const [list] = await db()
    .insert(familyShoppingLists)
    .values({ name: "Shopping", sortOrder: await nextListOrder() })
    .returning({ id: familyShoppingLists.id });
  return list.id;
}

async function listIdByName(name: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: familyShoppingLists.id })
    .from(familyShoppingLists)
    .where(sql`lower(${familyShoppingLists.name}) = lower(${clean(name, 60)})`)
    .orderBy(asc(familyShoppingLists.sortOrder))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Adds an item to a store on a list (by id, or by name via `list`; the
 * first active list when neither matches). The store section is created if
 * needed. Adding something already on that store's list un-ticks it instead
 * of adding it twice. Returns the item id.
 */
export async function addShoppingItem(
  input: { name: string; store: string; quantity?: string | null; listId?: string; list?: string | null },
  now = new Date(),
): Promise<string> {
  const name = clean(input.name, 80);
  if (!name) throw new Error("Item name is required");
  const byName = !input.listId && input.list ? await listIdByName(input.list) : null;
  const listId = input.listId ?? byName ?? (await defaultListId(now));
  const sectionId = await sectionFor(listId, input.store);
  const existing = (await db().select().from(familyShoppingItems).where(eq(familyShoppingItems.sectionId, sectionId))).find(
    (i) => itemKey(i.name) === itemKey(name),
  );
  const quantity = cleanQty(input.quantity);
  if (existing) {
    await db()
      .update(familyShoppingItems)
      .set({ checked: false, checkedAt: null, ...(quantity && { quantity }) })
      .where(eq(familyShoppingItems.id, existing.id));
    await bump();
    return existing.id;
  }
  const [row] = await db().select({ m: max(familyShoppingItems.sortOrder) }).from(familyShoppingItems).where(eq(familyShoppingItems.sectionId, sectionId));
  const [item] = await db()
    .insert(familyShoppingItems)
    .values({ sectionId, name, quantity, sortOrder: (row?.m ?? -1) + 1, createdAt: now })
    .returning({ id: familyShoppingItems.id });
  await bump();
  return item.id;
}

/** One item with its store and list, flattened (for the assistant and other single-item callers). */
export type ShoppingItemRow = {
  id: string;
  name: string;
  quantity: string | null;
  checked: boolean;
  store: string;
  sectionId: string;
  listId: string;
  list: string;
  /** Set while the list is put off until that date. */
  deferredUntil: string | null;
};

function rowsQuery() {
  return db()
    .select({
      id: familyShoppingItems.id,
      name: familyShoppingItems.name,
      quantity: familyShoppingItems.quantity,
      checked: familyShoppingItems.checked,
      store: familyShoppingSections.store,
      sectionId: familyShoppingSections.id,
      listId: familyShoppingLists.id,
      list: familyShoppingLists.name,
      deferredUntil: familyShoppingLists.deferredUntil,
    })
    .from(familyShoppingItems)
    .innerJoin(familyShoppingSections, eq(familyShoppingSections.id, familyShoppingItems.sectionId))
    .innerJoin(familyShoppingLists, eq(familyShoppingLists.id, familyShoppingSections.listId));
}

/** Every item on every list, in display order (lists, then stores, then items). */
export async function listShoppingItems(): Promise<ShoppingItemRow[]> {
  return rowsQuery().orderBy(
    asc(familyShoppingLists.sortOrder),
    asc(familyShoppingLists.createdAt),
    asc(familyShoppingSections.sortOrder),
    asc(familyShoppingItems.sortOrder),
    asc(familyShoppingItems.createdAt),
  );
}

export async function getShoppingItem(id: string): Promise<ShoppingItemRow | null> {
  const [row] = await rowsQuery().where(eq(familyShoppingItems.id, id));
  return row ?? null;
}

/**
 * Edits one item. A new store moves it to that store on the same list (the
 * section is created if needed); `checked` goes through setShoppingChecked,
 * so it ticks the same item on the other active lists too.
 */
export async function updateShoppingItem(
  id: string,
  patch: { name?: string; quantity?: string | null; store?: string; checked?: boolean },
  now = new Date(),
) {
  const item = await getShoppingItem(id);
  if (!item) throw new ShoppingNotFoundError("Item");
  const name = patch.name !== undefined ? clean(patch.name, 80) : undefined;
  let sectionId: string | undefined;
  if (patch.store !== undefined && clean(patch.store, 40).toLowerCase() !== item.store.toLowerCase()) {
    sectionId = await sectionFor(item.listId, patch.store);
    const [row] = await db().select({ m: max(familyShoppingItems.sortOrder) }).from(familyShoppingItems).where(eq(familyShoppingItems.sectionId, sectionId));
    await db().update(familyShoppingItems).set({ sectionId, sortOrder: (row?.m ?? -1) + 1 }).where(eq(familyShoppingItems.id, id));
  }
  if (name || patch.quantity !== undefined)
    await db()
      .update(familyShoppingItems)
      .set({ ...(name && { name }), ...(patch.quantity !== undefined && { quantity: cleanQty(patch.quantity) }) })
      .where(eq(familyShoppingItems.id, id));
  if (patch.checked !== undefined && patch.checked !== item.checked) await setShoppingChecked(id, patch.checked, now);
  else await bump();
}

/** Ids of every item on an active list (not deferred). */
async function activeItems(now: Date) {
  const today = todayHere(now);
  const rows = await db()
    .select({
      id: familyShoppingItems.id,
      name: familyShoppingItems.name,
      checked: familyShoppingItems.checked,
      checkedAt: familyShoppingItems.checkedAt,
      deferredUntil: familyShoppingLists.deferredUntil,
    })
    .from(familyShoppingItems)
    .innerJoin(familyShoppingSections, eq(familyShoppingSections.id, familyShoppingItems.sectionId))
    .innerJoin(familyShoppingLists, eq(familyShoppingLists.id, familyShoppingSections.listId));
  return rows.filter((r) => !isDeferred(r.deferredUntil, today));
}

/**
 * Ticks (or un-ticks) an item. Ticking also ticks the same item on every
 * other active list, so eggs bought at one store are off every list.
 * Un-ticking undoes exactly the items that tick touched. Returns the ids changed.
 */
export async function setShoppingChecked(id: string, checked: boolean, now = new Date()): Promise<string[]> {
  const [item] = await db().select().from(familyShoppingItems).where(eq(familyShoppingItems.id, id));
  if (!item) throw new ShoppingNotFoundError("Item");
  const key = itemKey(item.name);
  let ids: string[];
  if (checked) {
    if (item.checked) return [];
    ids = (await activeItems(now)).filter((r) => !r.checked && itemKey(r.name) === key).map((r) => r.id);
    if (!ids.includes(id)) ids.push(id);
    await db().update(familyShoppingItems).set({ checked: true, checkedAt: now }).where(inArray(familyShoppingItems.id, ids));
  } else {
    if (!item.checked) return [];
    const at = item.checkedAt?.getTime();
    ids = (await activeItems(now)).filter((r) => r.checked && itemKey(r.name) === key && r.checkedAt?.getTime() === at).map((r) => r.id);
    if (!ids.includes(id)) ids.push(id);
    await db().update(familyShoppingItems).set({ checked: false, checkedAt: null }).where(inArray(familyShoppingItems.id, ids));
  }
  await bump();
  return ids;
}

export async function deleteShoppingItem(id: string) {
  await db().delete(familyShoppingItems).where(eq(familyShoppingItems.id, id));
  await bump();
}

/**
 * Moves an item to `index` among the items still to buy in a section (same
 * store, another store, or another list). Ticked items stay after them.
 */
export async function moveShoppingItem(id: string, toSectionId: string, index: number) {
  const [item] = await db().select().from(familyShoppingItems).where(eq(familyShoppingItems.id, id));
  if (!item) throw new ShoppingNotFoundError("Item");
  const [section] = await db().select({ id: familyShoppingSections.id }).from(familyShoppingSections).where(eq(familyShoppingSections.id, toSectionId));
  if (!section) throw new ShoppingNotFoundError("Store");
  const siblings = await db()
    .select({ id: familyShoppingItems.id, checked: familyShoppingItems.checked })
    .from(familyShoppingItems)
    .where(eq(familyShoppingItems.sectionId, toSectionId))
    .orderBy(asc(familyShoppingItems.sortOrder), asc(familyShoppingItems.createdAt));
  const open = siblings.filter((s) => !s.checked && s.id !== id).map((s) => s.id);
  const done = siblings.filter((s) => s.checked && s.id !== id).map((s) => s.id);
  const order = item.checked ? [...open, ...placeAt(done, id, done.length)] : [...placeAt(open, id, index), ...done];
  if (item.sectionId !== toSectionId) await db().update(familyShoppingItems).set({ sectionId: toSectionId }).where(eq(familyShoppingItems.id, id));
  for (const [n, sid] of order.entries()) await db().update(familyShoppingItems).set({ sortOrder: n }).where(eq(familyShoppingItems.id, sid));
  await bump();
}

// ---------------------------------------------------------- templates ----

export async function listTemplates(): Promise<ShoppingTemplate[]> {
  const [templates, items] = await Promise.all([
    db().select().from(familyShoppingTemplates).orderBy(asc(familyShoppingTemplates.createdAt), asc(familyShoppingTemplates.name)),
    db()
      .select()
      .from(familyShoppingTemplateItems)
      .orderBy(asc(familyShoppingTemplateItems.storeOrder), asc(familyShoppingTemplateItems.sortOrder)),
  ]);
  return templates.map((t) => {
    const stores: ShoppingTemplateStore[] = [];
    for (const i of items.filter((x) => x.templateId === t.id)) {
      let s = stores.find((x) => x.store === i.store);
      if (!s) stores.push((s = { store: i.store, items: [] }));
      s.items.push({ name: i.name, quantity: i.quantity });
    }
    return { id: t.id, name: t.name, stores };
  });
}

/**
 * Saves a list's stores and items (ticked or not) as a template. A template
 * with the same name is replaced. Returns the template id.
 */
export async function saveListAsTemplate(listId: string, name: string): Promise<string> {
  const board = await shoppingBoard();
  const list = [...board.lists, ...board.deferred].find((l) => l.id === listId);
  if (!list) throw new ShoppingNotFoundError("List");
  const n = clean(name, 60) || list.name;
  const [existing] = await db().select({ id: familyShoppingTemplates.id }).from(familyShoppingTemplates).where(eq(familyShoppingTemplates.name, n));
  let templateId: string;
  if (existing) {
    templateId = existing.id;
    await db().delete(familyShoppingTemplateItems).where(eq(familyShoppingTemplateItems.templateId, templateId));
  } else {
    [{ id: templateId }] = await db().insert(familyShoppingTemplates).values({ name: n }).returning({ id: familyShoppingTemplates.id });
  }
  const rows = list.sections.flatMap((s, si) => s.items.map((i, ii) => ({ templateId, store: s.store, storeOrder: si, name: i.name, quantity: i.quantity, sortOrder: ii })));
  if (rows.length) await db().insert(familyShoppingTemplateItems).values(rows);
  await bump();
  return templateId;
}

export async function deleteTemplate(id: string) {
  await db().delete(familyShoppingTemplates).where(eq(familyShoppingTemplates.id, id));
  await bump();
}

// -------------------------------------------------------- housekeeping ----

/**
 * Ticked items leave their lists 12 hours after they were ticked, and a list
 * left empty by that goes too (everything on it was bought). Returns how
 * many items went.
 */
export async function clearBoughtItems(now = new Date()): Promise<number> {
  const rows = await db()
    .delete(familyShoppingItems)
    .where(
      and(
        eq(familyShoppingItems.checked, true),
        isNotNull(familyShoppingItems.checkedAt),
        lt(familyShoppingItems.checkedAt, new Date(now.getTime() - BOUGHT_ITEM_TTL_MS)),
      ),
    )
    .returning({ sectionId: familyShoppingItems.sectionId });
  if (rows.length === 0) return 0;
  const touched = await db()
    .selectDistinct({ listId: familyShoppingSections.listId })
    .from(familyShoppingSections)
    .where(inArray(familyShoppingSections.id, [...new Set(rows.map((r) => r.sectionId))]));
  for (const { listId } of touched) {
    const [left] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(familyShoppingItems)
      .innerJoin(familyShoppingSections, eq(familyShoppingSections.id, familyShoppingItems.sectionId))
      .where(eq(familyShoppingSections.listId, listId));
    if (left.n === 0) await db().delete(familyShoppingLists).where(eq(familyShoppingLists.id, listId));
  }
  await bump();
  return rows.length;
}
