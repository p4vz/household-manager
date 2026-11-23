import "server-only";
import type { z } from "zod";
import { currentUser, UnauthorizedError, type HouseholdUser } from "@/core/auth/guard";
import { currentKioskDevice, type KioskDevice } from "@/core/kiosk/devices";

export type KioskActor = { kind: "member"; user: HouseholdUser } | { kind: "kiosk"; device: KioskDevice };

/**
 * For the few actions the kitchen screen may run (tick a chore, add a
 * shopping item, move a return along, tick an upkeep task, refresh the
 * calendar). Accepts an allowlisted member OR a paired, unrevoked kiosk
 * device. Everything else in the app uses `authedAction`, which a kiosk
 * cookie never satisfies.
 */
export function kioskAction<S extends z.ZodType, R>(input: S, fn: (data: z.infer<S>, actor: KioskActor) => Promise<R>) {
  return async (raw: unknown): Promise<R> => {
    const actor = await requireKioskOrMember();
    const data = input.parse(raw);
    return fn(data, actor);
  };
}

export async function requireKioskOrMember(): Promise<KioskActor> {
  const user = await currentUser();
  if (user) return { kind: "member", user };
  const device = await currentKioskDevice();
  if (device) return { kind: "kiosk", device };
  throw new UnauthorizedError();
}
