import "server-only";
import type { z } from "zod";
import { currentUser, UnauthorizedError, type HouseholdUser } from "@/core/auth/guard";
import { currentKioskDevice, type KioskDevice } from "@/core/kiosk/devices";
import { KioskNotAllowedError, kioskMay, type KioskAbility } from "@/core/kiosk/permissions";

export type KioskActor =
  | { kind: "member"; user: HouseholdUser }
  /** `adultUntil`: adult mode on this screen (adult PIN) ends then; null when locked. */
  | { kind: "kiosk"; device: KioskDevice; adultUntil: Date | null };

/**
 * For the actions the kitchen screen may run. Accepts an allowlisted member
 * OR a paired, unrevoked kiosk device, and then checks the named ability
 * (core/kiosk/permissions.ts): a plain kiosk device gets only child-safe
 * ones. Everything else in the app uses `authedAction`, which a kiosk
 * cookie never satisfies.
 */
export function kioskAction<S extends z.ZodType, R>(ability: KioskAbility, input: S, fn: (data: z.infer<S>, actor: KioskActor) => Promise<R>) {
  return async (raw: unknown): Promise<R> => {
    const actor = await requireKioskOrMember();
    if (!kioskMay(actor, ability)) throw new KioskNotAllowedError(ability);
    const data = input.parse(raw);
    return fn(data, actor);
  };
}

/**
 * A paired screen is always treated as the kitchen screen, even if a Google
 * session is somehow left in that browser: the device is checked first.
 */
export async function requireKioskOrMember(): Promise<KioskActor> {
  const device = await currentKioskDevice();
  if (device) return { kind: "kiosk", device, adultUntil: device.adultUntil };
  const user = await currentUser();
  if (user) return { kind: "member", user };
  throw new UnauthorizedError();
}
