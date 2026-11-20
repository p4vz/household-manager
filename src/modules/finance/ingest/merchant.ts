/**
 * Deterministic merchant cleanup for raw bank descriptions. AI cleanup can
 * refine this later, but charts and rules work off this value.
 */
const PREFIXES = [
  /^(sq|tst|sp|pp|paypal|py|dd|ic|in|dnh|sms|bt|cke|tcb)\s?\*\s*/i,
  /^(pos|debit card|debit|checkcard|check card|purchase|recurring)\s+(purchase\s+)?(authorized\s+on\s+\d{1,2}\/\d{1,2}\s+)?/i,
  /^ach\s+(debit|credit)\s+/i,
];

export function normalizeMerchant(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  for (const p of PREFIXES) s = s.replace(p, "");
  s = s
    .replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\b.*$/, "") // trailing dates and what follows
    .replace(/\s*#\s*\d+.*$/, "") // store numbers "#1234 ..."
    .replace(/\s+\d{3,}\b.*$/, "") // trailing reference numbers
    .replace(/[*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = raw.trim();
  return s === s.toUpperCase() ? titleCase(s) : s;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])([a-z']*)/g, (_, a: string, b: string) => a.toUpperCase() + b);
}

const TRANSFER_HINTS =
  /\b(transfer|xfer|payment thank you|autopay|auto pay|online payment|credit card payment|epay|mobile payment)\b/i;

export function looksLikeTransfer(description: string, category?: string | null): boolean {
  if (category && /^(transfer|credit card payment|transfers?)\b/i.test(category)) return true;
  return TRANSFER_HINTS.test(description);
}

export function guessAccountKind(name: string) {
  if (/(card|visa|mastercard|amex|express|discover|sapphire|freedom|venture|quicksilver|credit)/i.test(name)) return "credit" as const;
  if (/checking/i.test(name)) return "checking" as const;
  if (/saving|money market/i.test(name)) return "savings" as const;
  if (/loan|mortgage/i.test(name)) return "loan" as const;
  if (/brokerage|ira|401k|invest/i.test(name)) return "investment" as const;
  return "other" as const;
}
