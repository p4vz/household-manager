import { z } from "zod";

/**
 * The household event catalogue: every message one module can broadcast to
 * the others. Event names are `<owner module>.<pastTenseFact>`; only the
 * owning module may publish its events (the bus enforces this).
 *
 * Payloads carry ids, dates, amounts and short titles. They never carry
 * account numbers, raw bank payloads or secrets.
 */
const isoDate = z.iso.date();
const money = z.number().finite();

export const EventSchemas = {
  // ---- finance ----
  "finance.annualFeeUpcoming": z.object({
    accountId: z.string(),
    cardName: z.string(),
    dueDate: isoDate,
    amount: money,
  }),
  "finance.transactionsSynced": z.object({
    source: z.enum(["simplefin", "csv"]),
    inserted: z.number().int().nonnegative(),
  }),

  // ---- maintenance ----
  "maintenance.taskScheduled": z.object({
    taskId: z.string(),
    title: z.string(),
    dueDate: isoDate,
    estimatedCost: money.nullable(),
  }),
  "maintenance.taskCancelled": z.object({ taskId: z.string() }),
  "maintenance.costRecorded": z.object({
    taskId: z.string(),
    title: z.string(),
    date: isoDate,
    amount: money,
  }),

  // ---- calendar ----
  "calendar.eventCreated": z.object({
    eventId: z.string(),
    title: z.string(),
    startDate: isoDate,
    sourceModule: z.string().nullable(),
  }),

  // ---- trips ----
  "trips.tripPlanned": z.object({
    tripId: z.string(),
    name: z.string(),
    destination: z.string(),
    startDate: isoDate,
    endDate: isoDate,
    budget: money.nullable(),
  }),
  "trips.tripCancelled": z.object({ tripId: z.string() }),
} as const;

export type EventName = keyof typeof EventSchemas;
export type EventPayload<N extends EventName> = z.infer<(typeof EventSchemas)[N]>;
export const MODULES = ["finance", "maintenance", "calendar", "trips", "family"] as const;
export type ModuleName = (typeof MODULES)[number];
