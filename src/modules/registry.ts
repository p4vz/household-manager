import { bus } from "@/core/bus";
import type { EventBus } from "@/core/bus/bus";
import { calendarModule } from "./calendar/module";
import { financeModule } from "./finance/module";
import { maintenanceModule } from "./maintenance/module";
import { tripsModule } from "./trips/module";
import type { ModuleDefinition } from "./types";

export const MODULE_DEFINITIONS: readonly ModuleDefinition[] = [
  financeModule,
  maintenanceModule,
  calendarModule,
  tripsModule,
];

const g = globalThis as unknown as { __hmRegistered?: WeakSet<EventBus> };

/** Wire every module's subscriptions onto the bus, once per bus. */
export function registerModules(target: EventBus = bus): void {
  g.__hmRegistered ??= new WeakSet();
  if (g.__hmRegistered.has(target)) return;
  for (const m of MODULE_DEFINITIONS) m.register(target);
  g.__hmRegistered.add(target);
}
