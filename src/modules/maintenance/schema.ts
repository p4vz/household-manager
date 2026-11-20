import { date, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const maintenanceTasks = pgTable("maintenance_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  dueDate: date("due_date").notNull(),
  estimatedCost: numeric("estimated_cost", { precision: 12, scale: 2, mode: "number" }),
  actualCost: numeric("actual_cost", { precision: 12, scale: 2, mode: "number" }),
  completedOn: date("completed_on"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
