import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers for the kitchen screen's adult PIN (no DB, unit tested).
 *
 * A PIN is 4 to 8 digits. A short PIN is weak against someone holding the
 * database, so the real protection is online: only a paired screen can try
 * one, and a few wrong tries lock that screen out (core/kiosk/adult.ts).
 */
export const PIN_MIN = 4;
export const PIN_MAX = 8;
/** Adult mode lasts this long after a correct PIN, unless locked sooner. */
export const ADULT_MODE_MS = 5 * 60_000;
/** Wrong tries before a lockout, and how long the lockout lasts. */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCKOUT_MS = 15 * 60_000;

export function isPinShaped(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

const N = 16384;
const KEYLEN = 32;

/** "scrypt$<salt>$<hash>", base64url. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN, { N });
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function pinMatches(pin: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = scryptSync(pin, Buffer.from(salt, "base64url"), want.length, { N });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Refuses PINs a child would guess first. */
export function weakPinReason(pin: string): string | null {
  if (!isPinShaped(pin)) return `Use ${PIN_MIN} to ${PIN_MAX} digits.`;
  if (/^(\d)\1+$/.test(pin)) return "Don't use the same digit over and over.";
  if ("01234567890123456".includes(pin) || "98765432109876543".includes(pin)) return "Don't use digits in a row like 1234.";
  return null;
}
