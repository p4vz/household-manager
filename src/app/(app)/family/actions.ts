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
  addShoppingItem,
  archiveChore,
  deleteReturn,
  deleteShoppingItem,
  removeKid,
  setStaple,
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

export const addStapleAction = authedAction(
  z.object({ name: z.string().trim().min(1).max(80), store: z.string().trim().min(1).max(40), quantity: z.string().trim().max(20).optional() }),
  async (input) => {
    await addShoppingItem({ ...input, isStaple: true });
    refresh();
  },
);

export const setStapleAction = authedAction(z.object({ id, isStaple: z.boolean() }), async (input) => {
  await setStaple(input.id, input.isStaple);
  refresh();
});

export const deleteShoppingItemAction = authedAction(z.object({ id }), async (input) => {
  await deleteShoppingItem(input.id);
  refresh();
});

export const deleteReturnAction = authedAction(z.object({ id }), async (input) => {
  await deleteReturn(input.id);
  refresh();
});
