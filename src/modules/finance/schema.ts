import { date, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Finance tables. Accounts, transactions, budgets and reward profiles are
 * added in the finance milestones; this scaffold holds only the table that
 * other modules feed through the finance API.
 */
export const financeExpectedExpenses = pgTable(
  "finance_expected_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    date: date("date").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }).notNull(),
    category: text("category"),
    sourceModule: text("source_module").notNull(),
    sourceRef: text("source_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("finance_expected_source_uq").on(t.sourceModule, t.sourceRef)],
);
