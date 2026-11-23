import { boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Family hub: kids' chores, shopping lists and purchase returns, shown on the
 * kitchen kiosk and the phone view. House upkeep stays in the maintenance
 * module and calendar events in the calendar module; the hub reaches them
 * through their api.ts only.
 *
 * Names here are first names or nicknames typed by a parent. Never store full
 * legal names (docs/SECURITY.md).
 */
export const familyKids = pgTable("family_kids", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** First name or nickname shown on the board. */
  name: text("name").notNull(),
  /** Column colour (hex). */
  color: text("color").notNull().default("#3b82f6"),
  emoji: text("emoji").notNull().default("⭐"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const familyChores = pgTable(
  "family_chores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kidId: uuid("kid_id")
      .notNull()
      .references(() => familyKids.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Emoji shown large on the card for early and non-readers. */
    icon: text("icon").notNull().default("✅"),
    /** daily | weekly | once */
    recurrence: text("recurrence").$type<"daily" | "weekly" | "once">().notNull(),
    stars: integer("stars").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a parent removes the chore; history stays for stats. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("family_chores_kid_idx").on(t.kidId)],
);

export const familyChoreCompletions = pgTable(
  "family_chore_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kidId: uuid("kid_id")
      .notNull()
      .references(() => familyKids.id, { onDelete: "cascade" }),
    choreId: uuid("chore_id")
      .notNull()
      .references(() => familyChores.id, { onDelete: "cascade" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Chore day (daily, once) or Monday of the chore week (weekly); see time.ts. */
    dateBucket: date("date_bucket").notNull(),
    /** Stars earned, copied from the chore so history survives edits. */
    stars: integer("stars").notNull().default(1),
  },
  (t) => [
    uniqueIndex("family_chore_completions_uq").on(t.choreId, t.dateBucket),
    index("family_chore_completions_kid_idx").on(t.kidId, t.dateBucket),
  ],
);

export const familyShoppingItems = pgTable(
  "family_shopping_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    store: text("store").notNull(),
    quantity: text("quantity"),
    /** Staples stay on the default list; "Restock" unchecks them all. One-time items go once bought. */
    isStaple: boolean("is_staple").notNull().default(false),
    checked: boolean("checked").notNull().default(false),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("family_shopping_items_store_idx").on(t.store)],
);

export const familyPurchaseReturns = pgTable("family_purchase_returns", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemName: text("item_name").notNull(),
  store: text("store").notNull(),
  returnDeadline: date("return_deadline"),
  /** pending | packed_in_car | returned */
  status: text("status").$type<"pending" | "packed_in_car" | "returned">().notNull().default("pending"),
  /** Free text, e.g. "QR code in email". Do not paste card or account numbers. */
  notes: text("notes"),
  orderRef: text("order_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
});
