"use server";

import { z } from "zod";
import { kioskAction } from "@/core/actions/kiosk-action";
import {
  addShoppingItem,
  addStore,
  createList,
  deferList,
  moveShoppingItem,
  renameList,
  reorderLists,
  reorderStores,
  saveListAsTemplate,
  setShoppingChecked,
  shoppingBoard,
  shoppingRevision,
  type ShoppingBoard,
} from "@/modules/family/api";

/**
 * Shopping actions the kitchen screen may run (a member may too). Each one
 * answers with the whole board, so the screen that made the change shows it
 * at once; other screens pick it up through `syncShoppingAction`, which they
 * call every few seconds. Nothing here revalidates the page: the shopping
 * panel keeps its own state, which keeps a tap fast.
 *
 * Taking items, stores, lists or templates away for good is member-only
 * (app/(app)/family/actions.ts).
 */
const id = z.uuid();
const ids = z.array(id).max(200);
const name = z.string().trim().min(1).max(80);
const store = z.string().trim().min(1).max(40);
const listName = z.string().trim().min(1).max(60);

/** The board when it changed since `since`, otherwise null (one row read). */
export const syncShoppingAction = kioskAction(
  z.object({ since: z.number().int().min(-1) }),
  async ({ since }): Promise<ShoppingBoard | null> => ((await shoppingRevision()) === since ? null : shoppingBoard()),
);

export const addShoppingItemAction = kioskAction(
  z.object({ name, store, listId: id.optional(), quantity: z.string().trim().max(20).optional() }),
  async (input) => {
    await addShoppingItem(input);
    return shoppingBoard();
  },
);

export const setShoppingCheckedAction = kioskAction(z.object({ id, checked: z.boolean() }), async (input) => {
  await setShoppingChecked(input.id, input.checked);
  return shoppingBoard();
});

export const moveShoppingItemAction = kioskAction(
  z.object({ id, sectionId: id, index: z.number().int().min(0).max(1000) }),
  async (input) => {
    await moveShoppingItem(input.id, input.sectionId, input.index);
    return shoppingBoard();
  },
);

export const createShoppingListAction = kioskAction(
  z.object({ name: listName.optional(), templateId: id.optional() }),
  async (input) => {
    await createList(input);
    return shoppingBoard();
  },
);

export const renameShoppingListAction = kioskAction(z.object({ id, name: listName }), async (input) => {
  await renameList(input.id, input.name);
  return shoppingBoard();
});

export const deferShoppingListAction = kioskAction(z.object({ id, until: z.iso.date().nullable() }), async (input) => {
  await deferList(input.id, input.until);
  return shoppingBoard();
});

export const reorderShoppingListsAction = kioskAction(z.object({ ids }), async (input) => {
  await reorderLists(input.ids);
  return shoppingBoard();
});

export const addShoppingStoreAction = kioskAction(z.object({ listId: id, store }), async (input) => {
  await addStore(input.listId, input.store);
  return shoppingBoard();
});

export const reorderShoppingStoresAction = kioskAction(z.object({ listId: id, sectionIds: ids }), async (input) => {
  await reorderStores(input.listId, input.sectionIds);
  return shoppingBoard();
});

export const saveShoppingTemplateAction = kioskAction(z.object({ listId: id, name: listName }), async (input) => {
  await saveListAsTemplate(input.listId, input.name);
  return shoppingBoard();
});
