import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { coreKioskAdultPin, coreKioskDevices } from "@/core/db/core-schema";
import { ADULT_MODE_MS, PIN_LOCKOUT_MS, PIN_MAX_FAILURES, hashPin, pinMatches, weakPinReason } from "./pin";

/**
 * Adult mode on the kitchen screen. Kids use the screen, so a paired device
 * gets only child-safe abilities (permissions.ts). An adult types the
 * household PIN on the screen and that device gets adult abilities for five
 * minutes, held on the server (core_kiosk_devices.adult_until), or until
 * someone taps Lock.
 *
 * The PIN is set and changed only by a signed-in member in Settings, never
 * from the screen. A later fingerprint or face passkey replaces `tryAdultPin`
 * as the check and calls the same `startAdultMode`.
 */
const ROW = "household";

export class WeakPinError extends Error {}

export async function hasAdultPin(): Promise<boolean> {
  const [row] = await db().select({ id: coreKioskAdultPin.id }).from(coreKioskAdultPin).where(eq(coreKioskAdultPin.id, ROW));
  return Boolean(row);
}

/** Member-only (called from an authedAction). Ends adult mode on every screen. */
export async function setAdultPin(pin: string, updatedBy: string, now = new Date()): Promise<void> {
  const weak = weakPinReason(pin);
  if (weak) throw new WeakPinError(weak);
  const pinHash = hashPin(pin);
  await db()
    .insert(coreKioskAdultPin)
    .values({ id: ROW, pinHash, updatedBy, updatedAt: now })
    .onConflictDoUpdate({ target: coreKioskAdultPin.id, set: { pinHash, updatedBy, updatedAt: now } });
  await db().update(coreKioskDevices).set({ adultUntil: null, pinFailures: 0, pinLockedUntil: null });
}

export type PinResult =
  | { ok: true; until: Date }
  | { ok: false; reason: "no-pin" }
  | { ok: false; reason: "wrong"; triesLeft: number }
  | { ok: false; reason: "locked"; lockedUntil: Date };

/** One PIN try from a paired screen. Wrong tries count per screen; too many lock that screen out for a while. */
export async function tryAdultPin(deviceId: string, pin: string, now = new Date()): Promise<PinResult> {
  const [device] = await db()
    .select({ pinFailures: coreKioskDevices.pinFailures, pinLockedUntil: coreKioskDevices.pinLockedUntil })
    .from(coreKioskDevices)
    .where(eq(coreKioskDevices.id, deviceId));
  if (!device) return { ok: false, reason: "locked", lockedUntil: new Date(now.getTime() + PIN_LOCKOUT_MS) };
  if (device.pinLockedUntil && device.pinLockedUntil > now) return { ok: false, reason: "locked", lockedUntil: device.pinLockedUntil };

  const [row] = await db().select({ pinHash: coreKioskAdultPin.pinHash }).from(coreKioskAdultPin).where(eq(coreKioskAdultPin.id, ROW));
  if (!row) return { ok: false, reason: "no-pin" };

  if (pinMatches(pin, row.pinHash)) {
    return { ok: true, until: await startAdultMode(deviceId, now) };
  }
  const failures = device.pinFailures + 1;
  if (failures >= PIN_MAX_FAILURES) {
    const lockedUntil = new Date(now.getTime() + PIN_LOCKOUT_MS);
    await db().update(coreKioskDevices).set({ pinFailures: 0, pinLockedUntil: lockedUntil, adultUntil: null }).where(eq(coreKioskDevices.id, deviceId));
    return { ok: false, reason: "locked", lockedUntil };
  }
  await db().update(coreKioskDevices).set({ pinFailures: failures }).where(eq(coreKioskDevices.id, deviceId));
  return { ok: false, reason: "wrong", triesLeft: PIN_MAX_FAILURES - failures };
}

/** Called only after an adult was verified on this screen (PIN today; a passkey later). */
export async function startAdultMode(deviceId: string, now = new Date()): Promise<Date> {
  const until = new Date(now.getTime() + ADULT_MODE_MS);
  await db().update(coreKioskDevices).set({ adultUntil: until, pinFailures: 0, pinLockedUntil: null }).where(eq(coreKioskDevices.id, deviceId));
  return until;
}

export async function endAdultMode(deviceId: string): Promise<void> {
  await db().update(coreKioskDevices).set({ adultUntil: null }).where(eq(coreKioskDevices.id, deviceId));
}
