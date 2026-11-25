import type { ShoppingActions } from "@/modules/family/ui/shopping-panel";
import {
  addShoppingItemAction,
  addShoppingStoreAction,
  createShoppingListAction,
  deferShoppingListAction,
  moveShoppingItemAction,
  renameShoppingListAction,
  reorderShoppingListsAction,
  reorderShoppingStoresAction,
  saveShoppingTemplateAction,
  setShoppingCheckedAction,
  syncShoppingAction,
} from "./shopping-actions";

/** The shopping panel's actions, for the kiosk and the phone view. */
export const shoppingActions: ShoppingActions = {
  sync: syncShoppingAction,
  add: addShoppingItemAction,
  setChecked: setShoppingCheckedAction,
  moveItem: moveShoppingItemAction,
  createList: createShoppingListAction,
  renameList: renameShoppingListAction,
  deferList: deferShoppingListAction,
  reorderLists: reorderShoppingListsAction,
  addStore: addShoppingStoreAction,
  reorderStores: reorderShoppingStoresAction,
  saveTemplate: saveShoppingTemplateAction,
};
