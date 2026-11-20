import type { ModuleDefinition } from "../types";

export const maintenanceModule: ModuleDefinition = {
  name: "maintenance",
  title: "Home maintenance",
  href: "/maintenance",
  register() {
    // No subscriptions yet.
  },
};
