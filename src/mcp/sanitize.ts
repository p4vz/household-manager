/**
 * What leaves the server through the assistant (MCP) endpoint follows the
 * same rules as what goes to Gemini or Claude (docs/SECURITY.md, "What the
 * AI providers see"):
 *
 * 1. Tools build their answers field by field from whitelisted values:
 *    card nicknames, owner labels (User 1 / User 2 / Joint), dates,
 *    merchants, categories, amounts. Account ids, masks, institution data,
 *    confirmation numbers, documents and traveller names are never copied.
 * 2. Every string is then scrubbed here: legal names always, plus 4+ digit
 *    runs for finance answers, or 6+ digit runs for trip answers (so years
 *    and times survive). Values that are exactly an ISO date or timestamp
 *    are kept as they are.
 * 3. Two values skip the scrub, and only when a tool wraps them on purpose:
 *    `AppLink` (a link to a booking's page in this app, checked against a
 *    strict shape) and `SharedBookingCode` (a trip's booking code, which
 *    tools wrap only when both the trip's switch and the connection's
 *    "travel.booking_codes" permission are on). A shared code must still
 *    look like a booking code, so a card number, IBAN, wallet or email typed
 *    into the confirmation field is redacted anyway.
 */
import { legalNamesFromEnv, scrubReferenceText, scrubText, type LlmOwnerLabel } from "@/core/ai/sanitize";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const ISO_QUARTER = /^\d{4}-Q[1-4]$/;

export type ScrubMode = "finance" | "reference";

const REDACTED = "[redacted]";

/** A booking code a tool may hand out (see rule 3 above). */
export class SharedBookingCode {
  constructor(readonly value: string) {}
}

/** A link to a page of this app (see rule 3 above). */
export class AppLink {
  constructor(readonly href: string) {}
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BOOKING_LINK = new RegExp(`^https?://[a-z0-9.-]+(:\\d+)?/trips/[a-z0-9-]{1,120}/itinerary#step-${UUID}$`);

export function isBookingLink(href: string): boolean {
  return BOOKING_LINK.test(href);
}

/**
 * Whether a stored confirmation value is shaped like a booking code
 * (letters, digits and dashes, up to 24) and not like any identifier THE_RULE
 * protects: a card or e-ticket number (13+ digits), an IBAN, a wallet address
 * or an email.
 */
export function isShareableBookingCode(value: string): boolean {
  const v = value.trim();
  if (!/^[A-Za-z0-9-]{3,24}$/.test(v)) return false;
  const digits = v.replace(/-/g, "");
  if (/^\d{13,}$/.test(digits)) return false;
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,}$/i.test(digits)) return false;
  if (/^0x[a-f0-9]{16,}$/i.test(v) || /^(bc1|tb1|ltc1)/i.test(v)) return false;
  return true;
}

/**
 * Keys that may never leave, whatever a tool builds: a second line of
 * defence behind the field whitelists (THE_RULE in core/oauth/permissions).
 */
const FORBIDDEN_KEY =
  /^(id|accountId|.*(account|card|routing)(Number|No|Num|Mask)|.*iban.*|.*wallet.*|.*seed.*|.*ssn.*|.*passport.*|.*confirmation.*|.*email.*|.*phone.*|.*(legal|full)Name.*|.*birth.*|.*address.*|.*secret.*|.*token.*|simplefin.*|institution.*)$/i;

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY.test(key);
}

export function forAssistant<T>(value: T, mode: ScrubMode, legalNames = legalNamesFromEnv()): unknown {
  const scrub = mode === "finance" ? scrubText : scrubReferenceText;
  const walk = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (v instanceof SharedBookingCode) return isShareableBookingCode(v.value) ? v.value.trim() : REDACTED;
    if (v instanceof AppLink) return isBookingLink(v.href) ? v.href : undefined;
    if (typeof v === "string") return ISO_DATE.test(v) || ISO_QUARTER.test(v) ? v : scrub(v, legalNames);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).filter(([k]) => !isForbiddenKey(k)).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value);
}

const OWNER: Record<string, LlmOwnerLabel> = { user1: "User 1", user2: "User 2", joint: "Joint" };

/** Finance owner codes to the labels assistants see. Never names. */
export function ownerLabel(owner: string): LlmOwnerLabel {
  return OWNER[owner] ?? "Joint";
}
