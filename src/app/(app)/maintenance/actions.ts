"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { completeTask, deleteTask, scheduleTask } from "@/modules/maintenance/api";

const optionalNumber = z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().nonnegative().nullable());

function refresh() {
  revalidatePath("/maintenance");
  revalidatePath("/kiosk");
  revalidatePath("/family");
}

export const scheduleTaskAction = authedAction(
  z.object({
    title: z.string().trim().min(1).max(80),
    dueDate: z.iso.date(),
    recurrenceDays: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().min(1).max(3650).nullable()),
    estimatedCost: optionalNumber,
    notes: z.string().trim().max(300).optional(),
  }),
  async (input) => {
    await scheduleTask({ ...input, notes: input.notes || null });
    refresh();
  },
);

export const completeTaskAction = authedAction(
  z.object({ taskId: z.uuid(), date: z.iso.date(), actualCost: optionalNumber }),
  async ({ taskId, date, actualCost }) => {
    await completeTask(taskId, { date, actualCost });
    refresh();
  },
);

export const deleteTaskAction = authedAction(z.object({ taskId: z.uuid() }), async ({ taskId }) => {
  await deleteTask(taskId);
  refresh();
});
