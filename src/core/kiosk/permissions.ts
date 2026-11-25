/**
 * What the kitchen screen may do. Kids use it, so a plain kiosk device gets
 * only child-safe abilities: tick chores, add things (chores, shopping,
 * calendar events, returns, event pictures) and light edits that are easy
 * to undo (tick shopping items, arrange lists, change an event's details).
 * Everything else needs an adult: a signed-in member, or a kiosk screen in
 * adult mode (adult PIN, five minutes, `adultUntil`; core/kiosk/adult.ts).
 *
 * Money, trips, settings and the assistant never run through kioskAction at
 * all, even in adult mode: those actions use authedAction, which a kiosk
 * device cannot satisfy (tests/kiosk-lockdown.integration.test.ts).
 *
 * Pure, so it is unit tested.
 */
export const CHILD_SAFE_ABILITIES = [
  "hub.view",
  "chores.tick",
  "chores.add",
  "shopping.add",
  "shopping.tick",
  "shopping.arrange",
  "calendar.sync",
  "calendar.add",
  "calendar.edit",
  "calendar.photo.add",
  "returns.add",
  // Trying the adult PIN (rate limited, locks out) and locking adult mode again.
  "adult.unlock",
  "adult.lock",
] as const;

/** Needs an adult on the kitchen screen. */
export const ADULT_ABILITIES = ["returns.status", "upkeep.complete", "calendar.delete", "calendar.photo.remove", "kiosk.exit", "assistant.kitchen"] as const;

export type KioskAbility = (typeof CHILD_SAFE_ABILITIES)[number] | (typeof ADULT_ABILITIES)[number];

export type AbilityHolder =
  | { kind: "member" }
  /** `adultUntil`: when adult mode on this screen runs out (null: locked). */
  | { kind: "kiosk"; adultUntil?: Date | null };

export function isAdult(holder: AbilityHolder, now = new Date()): boolean {
  if (holder.kind === "member") return true;
  return Boolean(holder.adultUntil && holder.adultUntil.getTime() > now.getTime());
}

export function kioskMay(holder: AbilityHolder, ability: KioskAbility, now = new Date()): boolean {
  if ((CHILD_SAFE_ABILITIES as readonly string[]).includes(ability)) return true;
  return isAdult(holder, now);
}

export class KioskNotAllowedError extends Error {
  constructor(ability: KioskAbility) {
    super(`An adult needs to do that (${ability}).`);
    this.name = "KioskNotAllowedError";
  }
}
