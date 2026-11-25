"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import {
  CHORE_ICONS,
  KID_COLORS,
  RECURRENCES,
  addChore,
  addKid,
  archiveChore,
  deleteReturn,
  deleteList,
  deleteShoppingItem,
  deleteTemplate,
  removeStore,
  shoppingBoard,
  removeKid,
} from "@/modules/family/api";

/** Setup and deletions: members only (never the kiosk). */
const id = z.uuid();

function refresh() {
  revalidatePath("/family");
  revalidatePath("/kiosk");
}

export const addKidAction = authedAction(
  z.object({ name: z.string().trim().min(1).max(30), color: z.enum(KID_COLORS).optional(), emoji: z.string().max(8).optional() }),
  async (input) => {
    await addKid(input);
    refresh();
  },
);

export const removeKidAction = authedAction(z.object({ id }), async (input) => {
  await removeKid(input.id);
  refresh();
});

export const addChoreAction = authedAction(
  z.object({
    kidId: id,
    title: z.string().trim().min(1).max(60),
    icon: z.enum(CHORE_ICONS),
    recurrence: z.enum(RECURRENCES),
    stars: z.number().int().min(1).max(5),
  }),
  async (input) => {
    await addChore(input);
    refresh();
  },
);

export const archiveChoreAction = authedAction(z.object({ id }), async (input) => {
  await archiveChore(input.id);
  refresh();
});

// Shopping deletions answer with the board, like the kiosk shopping actions.

export const deleteShoppingItemAction = authedAction(z.object({ id }), async (input) => {
  await deleteShoppingItem(input.id);
  return shoppingBoard();
});

export const removeShoppingStoreAction = authedAction(z.object({ id }), async (input) => {
  await removeStore(input.id);
  return shoppingBoard();
});

export const deleteShoppingListAction = authedAction(z.object({ id }), async (input) => {
  await deleteList(input.id);
  return shoppingBoard();
});

export const deleteShoppingTemplateAction = authedAction(z.object({ id }), async (input) => {
  await deleteTemplate(input.id);
  return shoppingBoard();
});

export const deleteReturnAction = authedAction(z.object({ id }), async (input) => {
  await deleteReturn(input.id);
  refresh();
});
