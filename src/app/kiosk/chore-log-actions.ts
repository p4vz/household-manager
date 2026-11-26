"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { kioskAction } from "@/core/actions/kiosk-action";
import { ChoreLogError, addChoreDone, choreLog, removeChoreDone, type ChoreLogEntry } from "@/modules/family/api";

/**
 * The chore log on the kitchen screen. Anyone can look; adding a missed
 * chore or taking one off changes stars, so it needs adult mode (or a
 * signed-in parent).
 */
const id = z.uuid();

function refresh() {
  revalidatePath("/kiosk");
  revalidatePath("/family");
}

export const choreLogAction = kioskAction("hub.view", z.object({ kidId: id }), async ({ kidId }): Promise<{ today: string; entries: ChoreLogEntry[] }> => choreLog(kidId));

export const addChoreDoneAction = kioskAction(
  "chores.log.edit",
  z.object({ choreId: id, day: z.iso.date() }),
  async (input): Promise<{ error: string | null; added: boolean }> => {
    try {
      const added = await addChoreDone(input);
      refresh();
      return { error: added ? null : "That chore is already in the log for that day.", added };
    } catch (err) {
      if (err instanceof ChoreLogError) return { error: err.message, added: false };
      throw err;
    }
  },
);

export const removeChoreDoneAction = kioskAction("chores.log.edit", z.object({ id }), async ({ id: entryId }) => {
  await removeChoreDone(entryId);
  refresh();
});
