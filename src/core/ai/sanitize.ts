/**
 * LLM data sanitization. Two layers, both always applied:
 *
 * 1. Structural whitelist: `toLlmTransaction` / `toLlmAccount` copy only the
 *    allowed fields (card/account display name, owner label, date, merchant,
 *    category, amount). Account numbers, masks, routing numbers, institution
 *    ids and raw bank payloads are never copied, whatever the input holds.
 * 2. Text scrub: every free-text field is scrubbed of digit sequences that
 *    could be card/account/routing numbers (4+ digits, including masked or
 *    grouped forms) and of the household's legal names.
 *
 * The AI runner only accepts the branded `Sanitized<T>` type produced here,
 * so unsanitized data cannot reach a provider without a type error.
 */
declare const sanitizedBrand: unique symbol;
export type Sanitized<T> = T & { readonly [sanitizedBrand]: true };

export type LlmOwnerLabel = "User 1" | "User 2" | "Joint";

export type LlmTransaction = {
  date: string;
  merchant: string;
  category: string | null;
  amount: number;
  cardName: string;
  accountName: string;
  owner: LlmOwnerLabel;
};

export type LlmAccount = { cardName: string; accountName: string; owner: LlmOwnerLabel };

const REDACTED = "[redacted]";

// Masked or grouped numbers: "****1234", "xx-1234", "4111 1111 1111 1111", "021000021".
const NUMBER_PATTERNS: RegExp[] = [
  /[*xX•#]{2,}[\s-]*\d{2,}/g,
  /\b\d(?:[\s-]?\d){3,}\b/g,
];
const ENDING_IN = /\b(ending|ends)\s+(in|with)\s+\d+/gi;

/**
 * Identifiers that are never shared, whatever their digit count: crypto
 * wallet addresses, IBANs, email addresses, and booking/confirmation-style
 * codes (6+ capital letters and digits mixed, e.g. "K7Q2XZ", passport and
 * ticket numbers). Applied by both scrubbers below.
 */
const IDENTIFIER_PATTERNS: RegExp[] = [
  /\b0x[a-fA-F0-9]{40}\b/g, // Ethereum and EVM wallets
  /\b(?:bc1|tb1|ltc1)[a-z0-9]{20,90}\b/gi, // bech32 wallets (Bitcoin, Litecoin)
  /\b[13mn2][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, // base58 Bitcoin addresses
  /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{26,}\b/g, // any other long key-like token (Solana, XRP, API keys)
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, // IBAN
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email addresses
];
// Booking / confirmation codes: 6-20 capitals and digits, at least two of each.
const BOOKING_CODE = /\b(?=[A-Z0-9]*\d[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z][A-Z0-9]*[A-Z])[A-Z0-9]{6,20}\b/g;
// Flight numbers ("UA1234", "B6123") look similar but are not identifiers.
const FLIGHT_NUMBER = /^[A-Z][A-Z0-9]\d{1,4}$/;

export function scrubIdentifiers(input: string): string {
  let out = input;
  for (const p of IDENTIFIER_PATTERNS) out = out.replace(p, REDACTED);
  return out.replace(BOOKING_CODE, (m) => (FLIGHT_NUMBER.test(m) ? m : REDACTED));
}

export function scrubText(input: string, legalNames: readonly string[] = []): string {
  let out = scrubIdentifiers(input.replace(ENDING_IN, REDACTED));
  for (const p of NUMBER_PATTERNS) out = out.replace(p, REDACTED);
  out = scrubNames(out, legalNames);
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * A household name entry: "Daniel Smith" or "Daniel Smith=Danya" (legal
 * name, then the nickname people use). Pavel, 2026-11-25: first names and
 * nicknames are fine to share (Danya and Daniel, Raya and Raisa); surnames,
 * and so full legal names, are not.
 */
export function parseNameEntry(entry: string): { legal: string; given: string | null; nickname: string | null; surnames: string[] } {
  const [legalRaw, nickRaw] = entry.split("=");
  const legal = legalRaw.trim();
  const tokens = legal.split(/\s+/).filter(Boolean);
  const nickname = nickRaw?.trim() || null;
  // Single-word entries are treated as given names (nothing to hide); the rest of the name is surname(s).
  return { legal, given: tokens[0] ?? null, nickname, surnames: tokens.slice(1) };
}

/** Removes surnames (so full legal names) of the given entries; first names and nicknames stay. */
function scrubNames(input: string, entries: readonly string[]): string {
  const parsed = entries.map(parseNameEntry);
  const keep = new Set(parsed.flatMap((p) => [p.given, p.nickname]).filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase()));
  let out = input;
  for (const p of parsed) {
    // 3+ letters, so "Al" alone does not wipe "Alaska Air"; a surname that is also someone's first name stays.
    for (const part of p.surnames.filter((x) => x.length >= 3 && !keep.has(x.toLowerCase()))) {
      out = out.replace(new RegExp(`\\b${escapeRegExp(part)}\\b`, "gi"), REDACTED);
    }
  }
  return out;
}

/** "Danya (Daniel)" for each entry with a nickname: for prompts, so the AI knows who is who. */
export function householdNicknames(entries: readonly string[] = legalNamesFromEnv()): string[] {
  return entries
    .map(parseNameEntry)
    .filter((p) => p.nickname && p.given)
    .map((p) => (p.nickname!.toLowerCase() === p.given!.toLowerCase() ? p.nickname! : `${p.nickname} (${p.given})`));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function legalNamesFromEnv(): string[] {
  return (process.env.HOUSEHOLD_LEGAL_NAMES ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

type TxnInput = {
  date: string;
  merchant: string;
  category?: string | null;
  amount: number;
  cardName: string;
  accountName: string;
  owner: LlmOwnerLabel;
  // Anything else on the input is ignored on purpose.
  [extra: string]: unknown;
};

export function toLlmTransaction(t: TxnInput, legalNames = legalNamesFromEnv()): LlmTransaction {
  return {
    date: String(t.date).slice(0, 10),
    merchant: scrubText(String(t.merchant), legalNames),
    category: t.category == null ? null : scrubText(String(t.category), legalNames),
    amount: Number(t.amount),
    cardName: scrubText(String(t.cardName), legalNames),
    accountName: scrubText(String(t.accountName), legalNames),
    owner: t.owner,
  };
}

export function toLlmAccount(
  a: { cardName: string; accountName: string; owner: LlmOwnerLabel; [extra: string]: unknown },
  legalNames = legalNamesFromEnv(),
): LlmAccount {
  return {
    cardName: scrubText(String(a.cardName), legalNames),
    accountName: scrubText(String(a.accountName), legalNames),
    owner: a.owner,
  };
}

/**
 * Seal a payload built only from sanitized parts (plus aggregated numbers
 * and category/merchant strings). Free-text strings are scrubbed once more
 * on the way through.
 */
export function sanitizePayload<T>(payload: T, legalNames = legalNamesFromEnv()): Sanitized<T> {
  return deepScrub(payload, legalNames) as Sanitized<T>;
}

function deepScrub(value: unknown, legalNames: readonly string[]): unknown {
  if (typeof value === "string") return scrubText(value, legalNames);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, legalNames));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, isDateKey(k) ? v : deepScrub(v, legalNames)]),
    );
  }
  return value;
}

/** ISO dates ("2026-11-20") would otherwise trip the 4+ digit rule. */
function isDateKey(key: string): boolean {
  return /date|month|period|quarter/i.test(key);
}

/**
 * For reference material that is not financial (place names, Wikipedia
 * summaries, packing lists): years and opening times must survive, so only
 * long digit runs (6+, the shape of card, account, passport and phone
 * numbers), masked numbers and household legal names are removed.
 */
const LONG_NUMBER_PATTERNS: RegExp[] = [/[*xX•#]{2,}[\s-]*\d{2,}/g, /\b\d(?:[\s-]?\d){5,}\b/g];

export function scrubReferenceText(input: string, legalNames: readonly string[] = []): string {
  let out = scrubIdentifiers(input.replace(ENDING_IN, REDACTED));
  for (const p of LONG_NUMBER_PATTERNS) out = out.replace(p, REDACTED);
  out = scrubNames(out, legalNames);
  return out.replace(/\s{2,}/g, " ").trim();
}

export function sanitizeReferencePayload<T>(payload: T, legalNames = legalNamesFromEnv()): Sanitized<T> {
  const walk = (v: unknown): unknown =>
    typeof v === "string"
      ? scrubReferenceText(v, legalNames)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(payload) as Sanitized<T>;
}
