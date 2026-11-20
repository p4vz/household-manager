import "server-only";
import { asc, eq, isNull } from "drizzle-orm";
import { bus } from "@/core/bus";
import { db } from "@/core/db/client";
import { maintenanceTasks } from "./schema";

/** Home maintenance public API. Scaffold: tasks with due dates and costs. */
export async function scheduleTask(input: {
  title: string;
  dueDate: string;
  estimatedCost?: number | null;
}) {
  const [task] = await db()
    .insert(maintenanceTasks)
    .values({ title: input.title, dueDate: input.dueDate, estimatedCost: input.estimatedCost ?? null })
    .returning();
  await bus.publish("maintenance", "maintenance.taskScheduled", {
    taskId: task.id,
    title: task.title,
    dueDate: task.dueDate,
    estimatedCost: task.estimatedCost,
  });
  return task.id;
}

export async function completeTask(taskId: string, input: { date: string; actualCost: number }) {
  const [task] = await db()
    .update(maintenanceTasks)
    .set({ completedOn: input.date, actualCost: input.actualCost })
    .where(eq(maintenanceTasks.id, taskId))
    .returning();
  if (!task) throw new Error("Task not found");
  await bus.publish("maintenance", "maintenance.costRecorded", {
    taskId: task.id,
    title: task.title,
    date: input.date,
    amount: input.actualCost,
  });
}

export async function listOpenTasks() {
  return db()
    .select()
    .from(maintenanceTasks)
    .where(isNull(maintenanceTasks.completedOn))
    .orderBy(asc(maintenanceTasks.dueDate));
}
