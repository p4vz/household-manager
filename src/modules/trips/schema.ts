import { date, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const tripsTrips = pgTable("trips_trips", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  destination: text("destination").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  budget: numeric("budget", { precision: 12, scale: 2, mode: "number" }),
  status: text("status", { enum: ["planned", "cancelled"] }).notNull().default("planned"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
