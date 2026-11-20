import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** App-wide settings (AI provider choice, etc.), one row per key. */
export const coreSettings = pgTable("core_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
