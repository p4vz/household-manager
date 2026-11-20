import type { ModuleDefinition } from "../types";
import { upsertExpectedExpense } from "./api";

/** Finance hears about costs that originate in other modules. */
export const financeModule: ModuleDefinition = {
  name: "finance",
  title: "Finance",
  href: "/finance",
  register(bus) {
    bus.subscribe("maintenance.taskScheduled", "finance", async (e) => {
      if (e.estimatedCost == null) return;
      await upsertExpectedExpense(
        { module: "maintenance", ref: e.taskId },
        { title: e.title, date: e.dueDate, amount: e.estimatedCost, category: "Home Maintenance" },
      );
    });
    bus.subscribe("maintenance.costRecorded", "finance", (e) =>
      upsertExpectedExpense(
        { module: "maintenance", ref: e.taskId },
        { title: e.title, date: e.date, amount: e.amount, category: "Home Maintenance" },
      ),
    );
    bus.subscribe("trips.tripPlanned", "finance", async (e) => {
      if (e.budget == null) return;
      await upsertExpectedExpense(
        { module: "trips", ref: e.tripId },
        { title: `Trip: ${e.name}`, date: e.startDate, amount: e.budget, category: "Travel" },
      );
    });
  },
};
