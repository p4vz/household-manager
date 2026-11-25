import type { ModuleDefinition } from "../types";
import { autoLinkTripCharges } from "./expenses";

export const tripsModule: ModuleDefinition = {
  name: "trips",
  title: "Trips",
  href: "/trips",
  register(bus) {
    // After each bank sync or CSV import, tie the new charges to trips they
    // clearly belong to (strong matches only; the rest stay suggestions).
    bus.subscribe("finance.transactionsSynced", "trips", async (e) => {
      if (e.inserted === 0) return;
      await autoLinkTripCharges();
    });
  },
};
