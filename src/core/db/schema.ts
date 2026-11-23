/**
 * Aggregate schema for drizzle-kit and the DB client. This is the only file
 * outside a module allowed to import that module's schema. Each module owns
 * its tables (prefixed with the module name) and no module queries another
 * module's tables: it calls that module's api.ts instead.
 */
export * from "./core-schema";
export * from "@/modules/finance/schema";
export * from "@/modules/maintenance/schema";
export * from "@/modules/calendar/schema";
export * from "@/modules/trips/schema";
export * from "@/modules/family/schema";
