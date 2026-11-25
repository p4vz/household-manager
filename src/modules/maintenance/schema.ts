import { date, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
  /** The equipment or vehicle this is for (optional). */
  assetId: uuid("asset_id"),
  /** Mileage-based schedule for vehicles: due at this odometer reading, repeats every so many miles. */
  dueMileage: integer("due_mileage"),
  recurrenceMiles: integer("recurrence_miles"),
  lastDoneMileage: integer("last_done_mileage"),
  /** Area of the house: "Water filtration", "HVAC & heating", "Exterior & stormwater". */
  area: text("area"),
  /** What to buy or have on hand, e.g. "GE MWF filter". */
  parts: text("parts"),
  /** When this was last done (carried from the completed predecessor, or entered by hand). */
  lastDoneOn: date("last_done_on"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ASSET_KINDS = ["hvac", "roof", "appliance", "plumbing", "electrical", "exterior", "yard", "vehicle", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  hvac: "Heating & cooling",
  roof: "Roof",
  appliance: "Appliance",
  plumbing: "Plumbing",
  electrical: "Electrical",
  exterior: "Exterior",
  yard: "Yard",
  vehicle: "Vehicle",
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
  /**
   * Vehicles: make, model, year and the last odometer reading. Never a VIN
   * or plate number: there is deliberately no column for either.
   */
  make: text("make"),
  model: text("model"),
  year: integer("year"),
  mileage: integer("mileage"),
  mileageOn: date("mileage_on"),
  /** Last product-recall check (CPSC), newest results first. */
  recallCheckedAt: timestamp("recall_checked_at", { withTimezone: true }),
  recalls: jsonb("recalls").$type<RecallHit[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RecallHit = { title: string; date: string | null; url: string | null; hazard: string | null; remedy: string | null };

/**
 * House project and expense history: renovations, repairs, appliance
 * purchases. Entered by hand, seeded from Pavel's tracker, or added from a
 * transaction in the questionable-transactions tracker (then `transactionId`
 * links the bank record; it is an opaque id, never shown or sent to an AI).
 */
export const maintenanceProjects = pgTable("maintenance_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Exact date when known. */
  date: date("date"),
  /** Shown instead of a date when only a period is known ("2022 – 2023"). */
  period: text("period"),
  title: text("title").notNull(),
  vendor: text("vendor"),
  description: text("description"),
  amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }),
  /** For amounts that aren't one number: "~$600 – $800", "Included in scope". */
  amountNote: text("amount_note"),
  transactionId: uuid("transaction_id"),
  /** The equipment or vehicle the work was on (vehicle service history). */
  assetId: uuid("asset_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
