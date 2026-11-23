/**
 * Free-text fields on the family hub (return notes, order references) are
 * shown on a shared wall screen. THE RULE: never store card or account
 * numbers. This refuses text holding a card-number-shaped digit run (13-19
 * digits, optionally grouped, passing the Luhn check). Order numbers like
 * 112-1234567-1234567 are fine.
 */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function containsCardNumber(text: string): boolean {
  const candidates = [
    ...text.matchAll(/\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}\b/g),
    ...text.matchAll(/\b\d{13,19}\b/g),
  ].map((m) => m[0].replace(/\D/g, ""));
  return candidates.some((d) => d.length >= 13 && d.length <= 19 && luhn(d));
}

export class SensitiveTextError extends Error {
  constructor() {
    super("That looks like a card number. Card and account numbers are never stored here.");
  }
}

export function assertNoCardNumber(...texts: (string | null | undefined)[]) {
  for (const t of texts) if (t && containsCardNumber(t)) throw new SensitiveTextError();
}
