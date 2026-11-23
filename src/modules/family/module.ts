import type { ModuleDefinition } from "../types";

/** Family hub: kids' chores, shopping lists, returns, and the kitchen kiosk. */
export const familyModule: ModuleDefinition = {
  name: "family",
  title: "Family hub",
  href: "/family",
  register() {
    // No subscriptions yet.
  },
};
