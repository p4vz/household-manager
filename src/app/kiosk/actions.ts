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
  completeChore,
  setReturnStatus,
  undoChore,
} from "@/modules/family/api";
import { householdToday } from "@/modules/family/ui/dates";
import { HouseTodoError, addHouseTodo, completeTask, deferTask } from "@/modules/maintenance/api";

/**
 * What the kitchen screen can do (shopping lists: shopping-actions.ts). Built with kioskAction: an allowlisted
 * member (the phone view uses these too) or a paired kiosk device. Setup
 * changes and anything destructive are member-only actions.
 */
const id = z.uuid();
const name = z.string().trim().min(1).max(80);
const store = z.string().trim().min(1).max(40);

function refresh() {
  revalidatePath("/kiosk");
  revalidatePath("/family");
  revalidatePath("/calendar");
}

export const setChoreDoneAction = kioskAction("chores.tick", z.object({ choreId: id, done: z.boolean() }), async ({ choreId, done }) => {
  if (done) await completeChore(choreId);
  else await undoChore(choreId);
  refresh();
});

export const addOneTimeChoreAction = kioskAction("chores.add", 
  z.object({ kidId: id, title: z.string().trim().min(1).max(60), icon: z.enum(CHORE_ICONS).optional() }),
  async (input) => {
    await addChore({ ...input, recurrence: "once" });
    refresh();
  },
);

export const addReturnAction = kioskAction("returns.add", 
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

export const setReturnStatusAction = kioskAction("returns.status", z.object({ id, status: z.enum(RETURN_STATUSES) }), async (input) => {
  await setReturnStatus(input.id, input.status);
  refresh();
});

/** Ticks an upkeep task done today; a repeating task schedules its next date. */
export const completeUpkeepAction = kioskAction("upkeep.complete", z.object({ taskId: id }), async ({ taskId }) => {
  await completeTask(taskId, { date: householdToday() });
  refresh();
  revalidatePath("/maintenance");
});

/** Adds a one-time house to-do (what, and who will do it), dated today. */
export const addHouseTodoAction = kioskAction(
  "upkeep.add",
  z.object({ title: z.string().trim().min(1).max(160), assignee: z.string().trim().max(40).optional() }),
  async ({ title, assignee }) => {
    try {
      await addHouseTodo({ title, assignee, today: householdToday() });
    } catch (err) {
      if (err instanceof HouseTodoError) return { error: err.message };
      throw err;
    }
    refresh();
    revalidatePath("/maintenance");
    return { error: null };
  },
);

/** "Defer until": hides a to-do or upkeep task until that day. */
export const deferUpkeepAction = kioskAction("upkeep.defer", z.object({ taskId: id, until: z.iso.date() }), async ({ taskId, until }) => {
  try {
    await deferTask(taskId, until, householdToday());
  } catch (err) {
    if (err instanceof HouseTodoError) return { error: err.message };
    throw err;
  }
  refresh();
  return { error: null };
});

export const syncCalendarAction = kioskAction("calendar.sync", z.object({}), async () => {
  const state = await syncGoogleCalendars({ force: true });
  refresh();
  return { ok: state.ok, message: state.message };
});
