import "server-only";
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { bus } from "@/core/bus";
import { searchRecalls, searchVehicleRecalls } from "./recalls";
import { db } from "@/core/db/client";
import { ASSET_KINDS, ASSET_KIND_LABELS, maintenanceAssets, maintenanceProjects, maintenanceTasks, type AssetKind, type RecallHit } from "./schema";

export { ASSET_KINDS, ASSET_KIND_LABELS, type AssetKind, type RecallHit };

/** Areas the maintenance list is grouped by. Free text is allowed too. */
export const UPKEEP_AREAS = ["Water filtration", "HVAC & heating", "Plumbing", "Exterior & stormwater", "Appliances", "Electrical", "Yard", "Vehicles", "Other"] as const;

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
  assetId?: string | null;
  dueMileage?: number | null;
  recurrenceMiles?: number | null;
  lastDoneMileage?: number | null;
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
      assetId: input.assetId ?? null,
      dueMileage: input.dueMileage ?? null,
      recurrenceMiles: input.recurrenceMiles ?? null,
      lastDoneMileage: input.lastDoneMileage ?? null,
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
  input: { date: string; actualCost?: number | null; mileage?: number | null },
): Promise<{ nextTaskId: string | null }> {
  const [task] = await db()
    .update(maintenanceTasks)
    .set({ completedOn: input.date, actualCost: input.actualCost ?? null, ...(input.mileage != null && { lastDoneMileage: input.mileage }) })
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
  if (task.assetId && input.mileage != null) await recordMileage(task.assetId, input.mileage, input.date);
  if (!task.recurrenceDays && !task.recurrenceMiles) return { nextTaskId: null };
  const nextTaskId = await scheduleTask({
    title: task.title,
    // Mileage-only items still get a date: a yearly look, in case the car sits.
    dueDate: nextDueDate(input.date, task.recurrenceDays ?? 365),
    assetId: task.assetId,
    recurrenceMiles: task.recurrenceMiles,
    lastDoneMileage: input.mileage ?? null,
    dueMileage: task.recurrenceMiles && input.mileage != null ? input.mileage + task.recurrenceMiles : null,
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
      ...(input.assetId !== undefined && { assetId: input.assetId }),
      ...(input.dueMileage !== undefined && { dueMileage: input.dueMileage }),
      ...(input.recurrenceMiles !== undefined && { recurrenceMiles: input.recurrenceMiles }),
      ...(input.lastDoneMileage !== undefined && { lastDoneMileage: input.lastDoneMileage }),
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
  make?: string | null;
  model?: string | null;
  year?: number | null;
  mileage?: number | null;
  mileageOn?: string | null;
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
      make: input.make ?? null,
      model: input.model ?? null,
      year: input.year ?? null,
      mileage: input.mileage ?? null,
      mileageOn: input.mileageOn ?? null,
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

/** Removes equipment or a car; its open items go too, and its history entries stay (unlinked). */
export async function deleteAsset(id: string) {
  const open = await db()
    .select({ id: maintenanceTasks.id })
    .from(maintenanceTasks)
    .where(and(eq(maintenanceTasks.assetId, id), isNull(maintenanceTasks.completedOn)));
  for (const t of open) await deleteTask(t.id);
  await db().update(maintenanceTasks).set({ assetId: null }).where(eq(maintenanceTasks.assetId, id));
  await db().update(maintenanceProjects).set({ assetId: null }).where(eq(maintenanceProjects.assetId, id));
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
  /** Equipment or vehicle the work was on. */
  assetId?: string | null;
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
      assetId: input.assetId ?? null,
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

export { searchRecalls, searchVehicleRecalls };

/** Checks one piece of equipment against CPSC recalls and keeps the result on it. */
export async function checkAssetRecalls(id: string, at = new Date()) {
  const asset = await getAsset(id);
  if (!asset) throw new Error("Equipment not found");
  let hits: RecallHit[];
  if (asset.kind === "vehicle") {
    if (!asset.make || !asset.model || !asset.year) throw new Error("Add the car's make, model and year to check recalls");
    hits = await searchVehicleRecalls({ make: asset.make, model: asset.model, year: asset.year });
  } else {
    hits = await searchRecalls(asset.name);
  }
  await setAssetRecalls(id, hits, at);
  return hits;
}

/** "monthly", "every 6 months", "yearly", "every 2½ years"; "one-off" without a repeat. */
export function everyLabel(days: number | null | undefined): string {
  if (!days) return "one-off";
  const known: Record<number, string> = { 7: "weekly", 14: "every 2 weeks", 30: "monthly", 31: "monthly", 60: "every 2 months", 90: "every 3 months", 91: "every 3 months", 182: "every 6 months", 183: "every 6 months", 365: "yearly", 730: "every 2 years", 913: "every 2½ years", 1095: "every 3 years" };
  return known[days] ?? `every ${days} days`;
}

// ---------- vehicles ----------

/** Keeps the highest odometer reading seen (a typo can be fixed by editing the vehicle). */
export async function recordMileage(assetId: string, mileage: number, on: string) {
  const a = await getAsset(assetId);
  if (!a || a.kind !== "vehicle") return;
  if (a.mileage != null && mileage < a.mileage) return;
  await updateAsset(assetId, { mileage, mileageOn: on });
}

export async function listVehicles() {
  return (await listAssets()).filter((a) => a.kind === "vehicle");
}

/**
 * The usual car upkeep, as a starting point. State inspection and
 * registration are yearly in Pennsylvania; edit dates once known.
 */
export const STANDARD_VEHICLE_ITEMS: { title: string; parts: string | null; recurrenceDays: number | null; recurrenceMiles: number | null; notes: string }[] = [
  { title: "Oil change", parts: "Oil and filter (check the owner's manual for grade)", recurrenceDays: 182, recurrenceMiles: 5000, notes: "Every 5,000 miles or 6 months, whichever comes first; follow the manual if it says otherwise." },
  { title: "State safety inspection", parts: null, recurrenceDays: 365, recurrenceMiles: null, notes: "Yearly, with the emissions check where the county requires it. Set the due date from the sticker." },
  { title: "Registration renewal", parts: null, recurrenceDays: 365, recurrenceMiles: null, notes: "Renew before the expiry month on the registration card." },
  { title: "Tire rotation", parts: null, recurrenceDays: null, recurrenceMiles: 7500, notes: "Every 7,500 miles; check pressure and tread at the same time." },
];

export async function addVehicle(input: Omit<AssetInput, "kind">, opts: { standardItems?: boolean; today: string }) {
  const id = await addAsset({ ...input, kind: "vehicle", mileageOn: input.mileage != null ? (input.mileageOn ?? opts.today) : null });
  if (opts.standardItems) {
    for (const item of STANDARD_VEHICLE_ITEMS) {
      await scheduleTask({
        title: `${item.title}: ${input.name}`,
        area: "Vehicles",
        parts: item.parts,
        notes: item.notes,
        assetId: id,
        recurrenceDays: item.recurrenceDays,
        recurrenceMiles: item.recurrenceMiles,
        dueDate: opts.today,
        dueMileage: item.recurrenceMiles && input.mileage != null ? input.mileage + item.recurrenceMiles : null,
      });
    }
  }
  return id;
}

/** "every 6 months or 5,000 miles". */
export function scheduleLabel(days: number | null | undefined, miles: number | null | undefined): string {
  if (!miles) return everyLabel(days);
  const m = `every ${miles.toLocaleString("en-US")} miles`;
  return days ? `${everyLabel(days)} or ${m.replace(/^every /, "")}` : m;
}
