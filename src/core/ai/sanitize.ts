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

export function scrubText(input: string, legalNames: readonly string[] = []): string {
  let out = input.replace(ENDING_IN, REDACTED);
  for (const p of NUMBER_PATTERNS) out = out.replace(p, REDACTED);
  for (const name of legalNames) {
    for (const part of nameParts(name)) {
      out = out.replace(new RegExp(`\\b${escapeRegExp(part)}\\b`, "gi"), REDACTED);
    }
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function nameParts(full: string): string[] {
  const trimmed = full.trim();
  if (!trimmed) return [];
  // The full name and each part of 3+ letters (so "Al" alone does not wipe "Alaska Air").
  const parts = trimmed.split(/\s+/).filter((p) => p.length >= 3);
  return [trimmed, ...parts];
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
