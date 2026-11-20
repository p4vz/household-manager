import "server-only";
import { EventBus } from "./bus";

/**
 * The single household bus for this server process. Kept on globalThis so
 * dev hot-reloads do not create a second bus with no subscribers.
 */
const g = globalThis as unknown as { __hmBus?: EventBus };
export const bus: EventBus = (g.__hmBus ??= new EventBus());
export type { DeliveryResult } from "./bus";
