import "server-only";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { bus } from "@/core/bus";
import { db } from "@/core/db/client";
import { maintenanceTasks } from "./schema";

/**
 * Home maintenance public API: upkeep tasks with due dates, optional costs
 * and an optional repeat interval (HVAC filter every 90 days, humidifier pad
 * every 30). Completing a repeating task schedules the next one.
 */
export type ScheduleTaskInput = {
  title: string;
  dueDate: string;
  estimatedCost?: number | null;
  recurrenceDays?: number | null;
  notes?: string | null;
};

export async function scheduleTask(input: ScheduleTaskInput & { previousTaskId?: string | null }) {
  const [task] = await db()
    .insert(maintenanceTasks)
    .values({
      title: input.title,
      dueDate: input.dueDate,
      estimatedCost: input.estimatedCost ?? null,
      recurrenceDays: input.recurrenceDays ?? null,
      notes: input.notes ?? null,
      previousTaskId: input.previousTaskId ?? null,
    })
    .returning();
  await bus.publish("maintenance", "maintenance.taskScheduled", {
    taskId: task.id,
    title: task.title,
    dueDate: task.dueDate,
    estimatedCost: task.estimatedCost,
  });
  return task.id;
}

/** Next due date for a repeating task, counted from the day it was done. */
export function nextDueDate(doneOn: string, recurrenceDays: number): string {
  const d = new Date(`${doneOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + recurrenceDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Marks a task done. With a cost, finance hears about it. With a repeat
 * interval, the next occurrence is scheduled (and lands on the calendar and
 * in expected expenses like any new task). Completing twice does nothing.
 * Returns the id of the next task, if one was scheduled.
 */
export async function completeTask(
  taskId: string,
  input: { date: string; actualCost?: number | null },
): Promise<{ nextTaskId: string | null }> {
  const [task] = await db()
    .update(maintenanceTasks)
    .set({ completedOn: input.date, actualCost: input.actualCost ?? null })
    .where(and(eq(maintenanceTasks.id, taskId), isNull(maintenanceTasks.completedOn)))
    .returning();
  if (!task) {
    const [existing] = await db().select({ id: maintenanceTasks.id }).from(maintenanceTasks).where(eq(maintenanceTasks.id, taskId));
    if (!existing) throw new Error("Task not found");
    return { nextTaskId: null };
  }
  if (input.actualCost != null) {
    await bus.publish("maintenance", "maintenance.costRecorded", {
      taskId: task.id,
      title: task.title,
      date: input.date,
      amount: input.actualCost,
    });
  }
  if (!task.recurrenceDays) return { nextTaskId: null };
  const nextTaskId = await scheduleTask({
    title: task.title,
    dueDate: nextDueDate(input.date, task.recurrenceDays),
    estimatedCost: task.estimatedCost,
    recurrenceDays: task.recurrenceDays,
    notes: task.notes,
    previousTaskId: task.id,
  });
  return { nextTaskId };
}

export async function listOpenTasks() {
  return db()
    .select()
    .from(maintenanceTasks)
    .where(isNull(maintenanceTasks.completedOn))
    .orderBy(asc(maintenanceTasks.dueDate));
}

/** Open tasks due on or before `throughDate` (overdue ones included), soonest first. */
export async function listDueTasks(throughDate: string, limit = 20) {
  return db()
    .select({
      id: maintenanceTasks.id,
      title: maintenanceTasks.title,
      dueDate: maintenanceTasks.dueDate,
      recurrenceDays: maintenanceTasks.recurrenceDays,
      notes: maintenanceTasks.notes,
    })
    .from(maintenanceTasks)
    .where(and(isNull(maintenanceTasks.completedOn), lte(maintenanceTasks.dueDate, throughDate)))
    .orderBy(asc(maintenanceTasks.dueDate))
    .limit(limit);
}

export async function updateTask(taskId: string, input: Partial<ScheduleTaskInput>) {
  await db()
    .update(maintenanceTasks)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
      ...(input.estimatedCost !== undefined && { estimatedCost: input.estimatedCost }),
      ...(input.recurrenceDays !== undefined && { recurrenceDays: input.recurrenceDays }),
      ...(input.notes !== undefined && { notes: input.notes }),
    })
    .where(eq(maintenanceTasks.id, taskId));
  const [task] = await db().select().from(maintenanceTasks).where(eq(maintenanceTasks.id, taskId));
  if (task && !task.completedOn) {
    await bus.publish("maintenance", "maintenance.taskScheduled", {
      taskId: task.id,
      title: task.title,
      dueDate: task.dueDate,
      estimatedCost: task.estimatedCost,
    });
  }
}

export async function deleteTask(taskId: string) {
  const deleted = await db()
    .delete(maintenanceTasks)
    .where(and(eq(maintenanceTasks.id, taskId), isNull(maintenanceTasks.completedOn)))
    .returning({ id: maintenanceTasks.id });
  if (deleted.length) await bus.publish("maintenance", "maintenance.taskCancelled", { taskId });
}
