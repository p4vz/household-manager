import type { EventBus } from "@/core/bus/bus";
import type { ModuleName } from "@/core/bus/events";

/** What each module hands the registry: its name and its bus subscriptions. */
export type ModuleDefinition = {
  name: ModuleName;
  title: string;
  href: string;
  register(bus: EventBus): void;
};
