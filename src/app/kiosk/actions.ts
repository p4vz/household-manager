"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { kioskAction } from "@/core/actions/kiosk-action";
import { syncGoogleCalendars } from "@/modules/calendar/api";
import {
  CHORE_ICONS,
  RETURN_STATUSES,
  SensitiveTextError,
  addChore,
  addReturn,
  addShoppingItem,
  completeChore,
  restockStaples,
  setReturnStatus,
  setShoppingChecked,
  undoChore,
} from "@/modules/family/api";
import { householdToday } from "@/modules/family/ui/dates";
import { completeTask } from "@/modules/maintenance/api";

/**
 * What the kitchen screen can do. Built with kioskAction: an allowlisted
 * member (the phone view uses these too) or a paired kiosk device. Setup
 * changes and anything destructive are member-only actions.
 */
const id = z.uuid();
const name = z.string().trim().min(1).max(80);
const store = z.string().trim().min(1).max(40);

function refresh() {
  revalidatePath("/kiosk");
  revalidatePath("/family");
}

export const setChoreDoneAction = kioskAction(z.object({ choreId: id, done: z.boolean() }), async ({ choreId, done }) => {
  if (done) await completeChore(choreId);
  else await undoChore(choreId);
  refresh();
});

export const addOneTimeChoreAction = kioskAction(
  z.object({ kidId: id, title: z.string().trim().min(1).max(60), icon: z.enum(CHORE_ICONS).optional() }),
  async (input) => {
    await addChore({ ...input, recurrence: "once" });
    refresh();
  },
);

export const addShoppingItemAction = kioskAction(
  z.object({ name, store, quantity: z.string().trim().max(20).optional() }),
  async (input) => {
    await addShoppingItem(input);
    refresh();
  },
);

export const setShoppingCheckedAction = kioskAction(z.object({ id, checked: z.boolean() }), async (input) => {
  await setShoppingChecked(input.id, input.checked);
  refresh();
});

export const restockStaplesAction = kioskAction(z.object({ store: store.optional() }), async (input) => {
  await restockStaples(input.store);
  refresh();
});

export const addReturnAction = kioskAction(
  z.object({
    itemName: name,
    store,
    returnDeadline: z.iso.date().optional(),
    notes: z.string().trim().max(300).optional(),
    orderRef: z.string().trim().max(60).optional(),
  }),
  async (input): Promise<{ error: string | null }> => {
    try {
      await addReturn(input);
    } catch (err) {
      if (err instanceof SensitiveTextError) return { error: err.message };
      throw err;
    }
    refresh();
    return { error: null };
  },
);

export const setReturnStatusAction = kioskAction(z.object({ id, status: z.enum(RETURN_STATUSES) }), async (input) => {
  await setReturnStatus(input.id, input.status);
  refresh();
});

/** Ticks an upkeep task done today; a repeating task schedules its next date. */
export const completeUpkeepAction = kioskAction(z.object({ taskId: id }), async ({ taskId }) => {
  await completeTask(taskId, { date: householdToday() });
  refresh();
  revalidatePath("/maintenance");
});

export const syncCalendarAction = kioskAction(z.object({}), async () => {
  const state = await syncGoogleCalendars({ force: true });
  refresh();
  return { ok: state.ok, message: state.message };
});
