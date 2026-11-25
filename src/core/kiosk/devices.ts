import "server-only";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/core/db/client";
import { coreKioskDevices, coreKioskPairingCodes } from "@/core/db/core-schema";
import {
  KIOSK_COOKIE,
  PAIRING_TTL_MS,
  isTokenShaped,
  newDeviceToken,
  newPairingCode,
  normalizePairingCode,
  sha256,
} from "./pairing";

/**
 * Kitchen kiosk devices. A signed-in member makes a one-time pairing code in
 * Settings, types it on the wall screen at /kiosk/pair, and the screen gets
 * a device cookie. That cookie is honoured only by the /kiosk page and the
 * kiosk actions (`kioskAction`); every other page and action still needs an
 * allowlisted Google session. See docs/SECURITY.md ("Kitchen kiosk").
 */
/** `adultUntil`: adult mode on this screen ends then (core/kiosk/adult.ts); null when locked. */
export type KioskDevice = { id: string; name: string; adultUntil: Date | null };

const MAX_OPEN_CODES = 3;

export async function createPairingCode(createdBy: string, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
  // Expired and used codes are dropped; at most a few open codes at once.
  await db().delete(coreKioskPairingCodes).where(lt(coreKioskPairingCodes.expiresAt, now));
  const open = await db()
    .select({ codeHash: coreKioskPairingCodes.codeHash })
    .from(coreKioskPairingCodes)
    .where(and(isNull(coreKioskPairingCodes.usedAt), gt(coreKioskPairingCodes.expiresAt, now)))
    .orderBy(desc(coreKioskPairingCodes.createdAt));
  for (const old of open.slice(MAX_OPEN_CODES - 1)) {
    await db().delete(coreKioskPairingCodes).where(eq(coreKioskPairingCodes.codeHash, old.codeHash));
  }
  const code = newPairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  await db().insert(coreKioskPairingCodes).values({ codeHash: sha256(code), createdBy, expiresAt });
  return { code, expiresAt };
}

/**
 * Redeems a code once. Returns the new device token (to be set as a cookie)
 * or null. The code is marked used in the same statement that checks it, so
 * two screens cannot redeem one code.
 */
export async function redeemPairingCode(raw: string, deviceName: string, now = new Date()): Promise<string | null> {
  const code = normalizePairingCode(raw);
  if (!code) return null;
  const [used] = await db()
    .update(coreKioskPairingCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(coreKioskPairingCodes.codeHash, sha256(code)),
        isNull(coreKioskPairingCodes.usedAt),
        gt(coreKioskPairingCodes.expiresAt, now),
      ),
    )
    .returning({ createdBy: coreKioskPairingCodes.createdBy });
  if (!used) return null;
  const token = newDeviceToken();
  await db()
    .insert(coreKioskDevices)
    .values({ name: deviceName.trim().slice(0, 60) || "Kitchen screen", tokenHash: sha256(token), createdBy: used.createdBy });
  return token;
}

/**
 * One-tap pairing: a signed-in member pairs the screen they are standing at,
 * with no code to type. Same device token and limits as a redeemed code.
 * Only called from a member-only action (pairThisScreenAction).
 */
export async function pairDeviceForMember(createdBy: string, deviceName: string): Promise<string> {
  const token = newDeviceToken();
  await db()
    .insert(coreKioskDevices)
    .values({ name: deviceName.trim().slice(0, 60) || "Kitchen screen", tokenHash: sha256(token), createdBy });
  return token;
}

export async function verifyDeviceToken(token: string | undefined, now = new Date()): Promise<KioskDevice | null> {
  if (!isTokenShaped(token)) return null;
  const [device] = await db()
    .select({ id: coreKioskDevices.id, name: coreKioskDevices.name, lastSeenAt: coreKioskDevices.lastSeenAt, adultUntil: coreKioskDevices.adultUntil })
    .from(coreKioskDevices)
    .where(and(eq(coreKioskDevices.tokenHash, sha256(token)), isNull(coreKioskDevices.revokedAt)));
  if (!device) return null;
  if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await db().update(coreKioskDevices).set({ lastSeenAt: now }).where(eq(coreKioskDevices.id, device.id));
  }
  return { id: device.id, name: device.name, adultUntil: device.adultUntil };
}

/** The paired device making this request, from its cookie, or null. */
export async function currentKioskDevice(): Promise<KioskDevice | null> {
  const jar = await cookies();
  return verifyDeviceToken(jar.get(KIOSK_COOKIE)?.value);
}

export async function listKioskDevices() {
  return db()
    .select({
      id: coreKioskDevices.id,
      name: coreKioskDevices.name,
      createdBy: coreKioskDevices.createdBy,
      createdAt: coreKioskDevices.createdAt,
      lastSeenAt: coreKioskDevices.lastSeenAt,
    })
    .from(coreKioskDevices)
    .where(isNull(coreKioskDevices.revokedAt))
    .orderBy(desc(coreKioskDevices.createdAt));
}

export async function revokeKioskDevice(id: string, now = new Date()): Promise<void> {
  await db().update(coreKioskDevices).set({ revokedAt: now, adultUntil: null }).where(eq(coreKioskDevices.id, id));
}
