import { date, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const maintenanceTasks = pgTable("maintenance_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  dueDate: date("due_date").notNull(),
  estimatedCost: numeric("estimated_cost", { precision: 12, scale: 2, mode: "number" }),
  actualCost: numeric("actual_cost", { precision: 12, scale: 2, mode: "number" }),
  completedOn: date("completed_on"),
  /** Repeats this many days after it is done (HVAC filter: 90). Null = one-off. */
  recurrenceDays: integer("recurrence_days"),
  notes: text("notes"),
  /** The task this one was scheduled from when its predecessor was completed. */
  previousTaskId: uuid("previous_task_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
