import "server-only";
import { and, desc, eq, gt, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { maintenanceDocuments, maintenanceTasks } from "./schema";

export type MaintenanceActivity = {
  /** Upkeep items and to-dos marked done (by completion day, so a same-day visit may repeat one). */
  done: { id: string; title: string }[];
  /** One-time house to-dos added. */
  todosAdded: { id: string; title: string; assignee: string | null }[];
  binderAdded: { id: string; title: string }[];
};

const LIMIT = 6;

/** Upkeep done, to-dos added and binder papers filed after `since` (`sinceDay` = its household date). */
export async function maintenanceActivitySince(since: Date, sinceDay: string): Promise<MaintenanceActivity> {
  const d = db();
  const [done, todos, docs] = await Promise.all([
    d
      .select({ id: maintenanceTasks.id, title: maintenanceTasks.title })
      .from(maintenanceTasks)
      .where(and(isNotNull(maintenanceTasks.completedOn), gte(maintenanceTasks.completedOn, sinceDay)))
      .orderBy(desc(maintenanceTasks.completedOn))
      .limit(LIMIT * 4),
    d
      .select({ id: maintenanceTasks.id, title: maintenanceTasks.title, assignee: maintenanceTasks.assignee })
      .from(maintenanceTasks)
      .where(and(eq(maintenanceTasks.todo, true), gt(maintenanceTasks.createdAt, since), sql`${maintenanceTasks.completedOn} is null`))
      .orderBy(desc(maintenanceTasks.createdAt))
      .limit(LIMIT * 4),
    d
      .select({ id: maintenanceDocuments.id, title: maintenanceDocuments.title })
      .from(maintenanceDocuments)
      .where(gt(maintenanceDocuments.createdAt, since))
      .orderBy(desc(maintenanceDocuments.createdAt))
      .limit(LIMIT * 4),
  ]);
  return { done, todosAdded: todos, binderAdded: docs };
}
