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

export const ASSET_KINDS = ["hvac", "roof", "appliance", "plumbing", "electrical", "exterior", "yard", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  hvac: "Heating & cooling",
  roof: "Roof",
  appliance: "Appliance",
  plumbing: "Plumbing",
  electrical: "Electrical",
  exterior: "Exterior",
  yard: "Yard",
  other: "Other",
};

/**
 * Home equipment and big-ticket parts of the house (furnace, roof, water
 * heater, fridge): what it is, when it was installed or bought, what it
 * cost. Filled from the Finance review's large-purchase questions or by hand.
 */
export const maintenanceAssets = pgTable("maintenance_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ASSET_KINDS }).notNull().default("other"),
  location: text("location"),
  installedOn: date("installed_on"),
  cost: numeric("cost", { precision: 12, scale: 2, mode: "number" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
