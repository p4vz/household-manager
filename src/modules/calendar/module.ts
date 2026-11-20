import type { ModuleDefinition } from "../types";
import { removeEventFromSource, upsertEventFromSource } from "./api";

/** Calendar listens for dated things happening elsewhere in the household. */
export const calendarModule: ModuleDefinition = {
  name: "calendar",
  title: "Calendar",
  href: "/calendar",
  register(bus) {
    bus.subscribe("trips.tripPlanned", "calendar", (e) =>
      upsertEventFromSource(
        { module: "trips", ref: e.tripId },
        { title: `Trip: ${e.name}`, startDate: e.startDate, endDate: e.endDate, notes: e.destination },
      ).then(() => undefined),
    );
    bus.subscribe("trips.tripCancelled", "calendar", (e) =>
      removeEventFromSource({ module: "trips", ref: e.tripId }),
    );
    bus.subscribe("maintenance.taskScheduled", "calendar", (e) =>
      upsertEventFromSource(
        { module: "maintenance", ref: e.taskId },
        { title: `Maintenance: ${e.title}`, startDate: e.dueDate },
      ).then(() => undefined),
    );
    bus.subscribe("finance.annualFeeUpcoming", "calendar", (e) =>
      upsertEventFromSource(
        { module: "finance", ref: `annual-fee:${e.accountId}:${e.dueDate}` },
        { title: `Annual fee: ${e.cardName} ($${e.amount.toFixed(2)})`, startDate: e.dueDate },
      ).then(() => undefined),
    );
  },
};
