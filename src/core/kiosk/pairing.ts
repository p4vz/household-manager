import { createHash, randomBytes, randomInt } from "node:crypto";

/**
 * Pure helpers for kiosk pairing (no DB, so they are unit tested).
 *
 * A pairing code is 8 characters from a 31-letter alphabet without
 * look-alikes (no 0/O, 1/I/L), about 40 bits. It lives 10 minutes, works
 * once, and code entry is rate limited, so guessing is not practical.
 */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const KIOSK_COOKIE = "hm_kiosk";
/**
 * Set (path "/") next to the device cookie, which only rides on /kiosk. While
 * it is there the proxy sends every other page to /kiosk and drops any Google
 * session in that browser, so kids can't leave the kitchen screen for the
 * app. Holds no secret: only leaving kitchen mode (adult PIN) removes it.
 */
export const KIOSK_LOCK_COOKIE = "hm_kiosk_lock";
/** The device cookie lasts a year; unpairing in Settings ends it at once. */
export const KIOSK_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function newPairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

/** Uppercases and drops spaces and dashes; returns null if it cannot be a code. */
export function normalizePairingCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of code) if (!PAIRING_ALPHABET.includes(ch)) return null;
  return code;
}

/** Shown as ABCD-EFGH. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** 256-bit device token, base64url. */
export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A plausible device token (shape only); anything else is not looked up. */
export function isTokenShaped(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
