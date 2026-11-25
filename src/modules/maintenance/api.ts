import "server-only";
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { bus } from "@/core/bus";
import { searchRecalls } from "./recalls";
import { db } from "@/core/db/client";
import { ASSET_KINDS, ASSET_KIND_LABELS, maintenanceAssets, maintenanceProjects, maintenanceTasks, type AssetKind, type RecallHit } from "./schema";

export { ASSET_KINDS, ASSET_KIND_LABELS, type AssetKind, type RecallHit };

/** Areas the maintenance list is grouped by. Free text is allowed too. */
export const UPKEEP_AREAS = ["Water filtration", "HVAC & heating", "Plumbing", "Exterior & stormwater", "Appliances", "Electrical", "Yard", "Other"] as const;

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
  area?: string | null;
  parts?: string | null;
  lastDoneOn?: string | null;
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
      area: input.area ?? null,
      parts: input.parts ?? null,
      lastDoneOn: input.lastDoneOn ?? null,
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
    area: task.area,
    parts: task.parts,
    lastDoneOn: input.date,
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
      parts: maintenanceTasks.parts,
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
      ...(input.area !== undefined && { area: input.area }),
      ...(input.parts !== undefined && { parts: input.parts }),
      ...(input.lastDoneOn !== undefined && { lastDoneOn: input.lastDoneOn }),
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

/** One task by id, or null. */
export async function getTask(taskId: string) {
  const [task] = await db().select().from(maintenanceTasks).where(eq(maintenanceTasks.id, taskId));
  return task ?? null;
}

/** Open tasks plus tasks completed on or after `completedSince`, soonest due first. */
export async function listTasks(opts: { completedSince?: string | null; limit?: number } = {}) {
  return db()
    .select()
    .from(maintenanceTasks)
    .where(
      opts.completedSince
        ? or(isNull(maintenanceTasks.completedOn), gte(maintenanceTasks.completedOn, opts.completedSince))
        : isNull(maintenanceTasks.completedOn),
    )
    .orderBy(asc(maintenanceTasks.dueDate))
    .limit(Math.min(opts.limit ?? 200, 500));
}

// ---------- home equipment ----------

export type AssetInput = {
  name: string;
  kind: AssetKind;
  location?: string | null;
  installedOn?: string | null;
  cost?: number | null;
  notes?: string | null;
};

export async function addAsset(input: AssetInput): Promise<string> {
  const [row] = await db()
    .insert(maintenanceAssets)
    .values({
      name: input.name,
      kind: input.kind,
      location: input.location ?? null,
      installedOn: input.installedOn ?? null,
      cost: input.cost ?? null,
      notes: input.notes ?? null,
    })
    .returning({ id: maintenanceAssets.id });
  return row.id;
}

export async function getAsset(id: string) {
  const [row] = await db().select().from(maintenanceAssets).where(eq(maintenanceAssets.id, id));
  return row ?? null;
}

export async function updateAsset(id: string, patch: Partial<AssetInput>) {
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(set).length) return;
  await db().update(maintenanceAssets).set(set).where(eq(maintenanceAssets.id, id));
}

export async function deleteAsset(id: string) {
  await db().delete(maintenanceAssets).where(eq(maintenanceAssets.id, id));
}

export async function listAssets() {
  return db().select().from(maintenanceAssets).orderBy(asc(maintenanceAssets.kind), asc(maintenanceAssets.name));
}

/** Stores the result of a product-recall check for one piece of equipment. */
export async function setAssetRecalls(id: string, recalls: RecallHit[], at = new Date()) {
  await db().update(maintenanceAssets).set({ recalls, recallCheckedAt: at }).where(eq(maintenanceAssets.id, id));
}

// ---------- house project and expense history ----------

export type ProjectInput = {
  date?: string | null;
  period?: string | null;
  title: string;
  vendor?: string | null;
  description?: string | null;
  amount?: number | null;
  amountNote?: string | null;
  /** Finance transaction this project was paid with (opaque id). */
  transactionId?: string | null;
};

export async function addProject(input: ProjectInput): Promise<string> {
  const [row] = await db()
    .insert(maintenanceProjects)
    .values({
      date: input.date ?? null,
      period: input.period ?? null,
      title: input.title,
      vendor: input.vendor ?? null,
      description: input.description ?? null,
      amount: input.amount ?? null,
      amountNote: input.amountNote ?? null,
      transactionId: input.transactionId ?? null,
    })
    .returning({ id: maintenanceProjects.id });
  return row.id;
}

export async function getProject(id: string) {
  const [row] = await db().select().from(maintenanceProjects).where(eq(maintenanceProjects.id, id));
  return row ?? null;
}

export async function updateProject(id: string, patch: Partial<ProjectInput>) {
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(set).length) return;
  await db().update(maintenanceProjects).set(set).where(eq(maintenanceProjects.id, id));
}

export async function deleteProject(id: string) {
  await db().delete(maintenanceProjects).where(eq(maintenanceProjects.id, id));
}

/** Newest first; undated rows (known only by period) last. */
export async function listProjects() {
  return db()
    .select()
    .from(maintenanceProjects)
    .orderBy(sql`${maintenanceProjects.date} desc nulls last`, desc(maintenanceProjects.createdAt));
}

// ---------- recalls ----------

export { searchRecalls };

/** Checks one piece of equipment against CPSC recalls and keeps the result on it. */
export async function checkAssetRecalls(id: string, at = new Date()) {
  const asset = await getAsset(id);
  if (!asset) throw new Error("Equipment not found");
  const hits = await searchRecalls(asset.name);
  await setAssetRecalls(id, hits, at);
  return hits;
}

/** "monthly", "every 6 months", "yearly", "every 2½ years"; "one-off" without a repeat. */
export function everyLabel(days: number | null | undefined): string {
  if (!days) return "one-off";
  const known: Record<number, string> = { 7: "weekly", 14: "every 2 weeks", 30: "monthly", 31: "monthly", 60: "every 2 months", 90: "every 3 months", 91: "every 3 months", 182: "every 6 months", 183: "every 6 months", 365: "yearly", 730: "every 2 years", 913: "every 2½ years", 1095: "every 3 years" };
  return known[days] ?? `every ${days} days`;
}
