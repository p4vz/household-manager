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
  SensitiveTextError,
  addReturn,
  extractReturn,
  getOwnSuggestion,
  markSuggestion,
  memberFromLabel,
  setReturnStatus,
  today,
} from "@/modules/family/api";
import { rateLimit } from "@/core/net/rate-limit";

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

// ---- Returns found in email, and filling a return from a screenshot or text ----
// Members only. A member can act only on suggestions from their own mailboxes.

const returnFields = {
  itemName: z.string().trim().min(1).max(80),
  store: z.string().trim().min(1).max(40),
  returnDeadline: z.iso.date().optional(),
  notes: z.string().trim().max(300).optional(),
  orderRef: z.string().trim().max(60).optional(),
};

export const acceptSuggestionAction = authedAction(z.object({ id, ...returnFields }), async ({ id: suggestionId, ...fields }, user) => {
  const member = memberFromLabel(user.owner);
  await getOwnSuggestion(member, suggestionId);
  try {
    await addReturn(fields);
  } catch (err) {
    if (err instanceof SensitiveTextError) return { error: err.message };
    throw err;
  }
  await markSuggestion(member, suggestionId, "accepted");
  refresh();
  return { error: null };
});

export const markSuggestionReturnedAction = authedAction(z.object({ id }), async (input, user) => {
  const member = memberFromLabel(user.owner);
  const s = await getOwnSuggestion(member, input.id);
  if (!s.matchReturnId) return { error: "That refund is not linked to a return on the list." };
  await setReturnStatus(s.matchReturnId, "returned");
  await markSuggestion(member, input.id, "accepted");
  refresh();
  return { error: null };
});

export const dismissSuggestionAction = authedAction(z.object({ id }), async (input, user) => {
  await markSuggestion(memberFromLabel(user.owner), input.id, "dismissed");
  revalidatePath("/family");
});

export const extractReturnAction = authedAction(z.object({ text: z.string().trim().min(5).max(6000) }), async ({ text }, user) => {
  if (!rateLimit(`return-extract:${user.owner}`, 10, 60_000)) return { fields: null, error: "Too many tries. Wait a minute." };
  try {
    const out = await extractReturn({ text, receivedDate: today() });
    if (!out.isReturn && !out.store && !out.itemName) return { fields: null, error: "Could not find a return in that text. Fill it in by hand." };
    return {
      fields: {
        itemName: out.itemName ?? undefined,
        store: out.store ?? undefined,
        returnDeadline: out.returnDeadline ?? undefined,
        notes: out.howToReturn ?? undefined,
      },
      error: null,
    };
  } catch (err) {
    console.warn(`[returns] extract failed: ${err instanceof Error ? err.name : "error"}`);
    return { fields: null, error: "The AI could not read it. Check Settings → AI configuration, or fill it in by hand." };
  }
});
