import type { AccountKind } from "../schema";

/**
 * Account types (Pavel, 2026-11-26): bank accounts (checking, savings,
 * business checking) and cards (credit, business credit) are different
 * things, and nothing automatic may treat one as the other, for example by
 * suggesting a checking account's history be merged into a credit card.
 *
 * Plain code, no AI: the bank's account name gives the first guess, and the
 * account's own transactions (deposits and ATM withdrawals versus "payment
 * thank you" credits and interest charges) settle bank versus card when the
 * name says nothing. A type a person set is never changed.
 */

export type AccountFamily = "bank" | "card" | "loan" | "investment";

export function accountFamily(kind: AccountKind): AccountFamily | null {
  switch (kind) {
    case "checking":
    case "savings":
    case "business_checking":
      return "bank";
    case "credit":
    case "business_credit":
      return "card";
    case "loan":
      return "loan";
    case "investment":
      return "investment";
    default:
      return null;
  }
}

/** False when both types are known and of different families (e.g. checking and a credit card). */
export function kindsCompatible(a: AccountKind, b: AccountKind): boolean {
  const x = accountFamily(a);
  const y = accountFamily(b);
  return !x || !y || x === y;
}

const BUSINESS = /\b(business|biz|ink)\b/i;
const SAVINGS = /saving|way2save|money market|\bcd\b|certificate of deposit/i;
const CHECKING = /checking|\bchk\b|debit account/i;
const CARD =
  /(credit card|\bcard\b|visa|mastercard|amex|american express|discover|sapphire|freedom|venture|quicksilver|savor|active cash|autograph|reflect|signify|bilt|\bcredit\b|\bink\b)/i;

/** First guess from the bank's account name. Explicit "checking"/"savings" wins over brand words. */
export function guessAccountKind(name: string): AccountKind {
  const business = BUSINESS.test(name);
  if (/credit card/i.test(name)) return business ? "business_credit" : "credit";
  if (CHECKING.test(name)) return business ? "business_checking" : "checking";
  if (SAVINGS.test(name)) return "savings";
  if (CARD.test(name)) return business ? "business_credit" : "credit";
  if (/loan|mortgage|heloc/i.test(name)) return "loan";
  if (/brokerage|\bira\b|401k|invest/i.test(name)) return "investment";
  return "other";
}

/** Money in that only a card sees: the payment from the bank, or a rewards credit. */
const CARD_CREDIT = /(payment\s*[-–]?\s*thank\s*you|thank you for (your )?payment|autopay payment|cash ?back redemption|rewards? redemption|statement credit)/i;
/** Charges that only a card sees. */
const CARD_CHARGE = /(interest charge|purchase interest|annual (membership )?fee|late (payment )?fee|cash advance)/i;
/** Activity that only a bank account sees. */
const BANK_ACTIVITY =
  /(deposit|payroll|direct dep|dir dep|\batm\b|zelle|wire trans|overdraft|monthly service fee|online transfer (to|from)|recurring transfer (to|from)|interest payment|venmo cashout|withdrawal|bill pay|\bcheck\s*#?\s*\d+)/i;

export type KindTxn = { amount: number; description: string };

/** Bank versus card from an account's transactions, or null when they don't say clearly. */
export function familyFromActivity(txns: KindTxn[]): "bank" | "card" | null {
  let bank = 0;
  let card = 0;
  for (const t of txns) {
    const d = t.description;
    if (BANK_ACTIVITY.test(d)) bank++;
    else if (t.amount > 0 && CARD_CREDIT.test(d)) card++;
    else if (t.amount < 0 && CARD_CHARGE.test(d)) card++;
  }
  if (bank >= 2 && card * 4 <= bank) return "bank";
  if (card >= 2 && bank * 4 <= card) return "card";
  return null;
}

/**
 * The account's type from its name and, where they agree or the name is
 * silent, its activity. Loans and investments named as such stay as named.
 */
export function inferAccountKind(name: string, txns: KindTxn[]): AccountKind {
  const guess = guessAccountKind(name);
  const named = accountFamily(guess);
  if (named === "loan" || named === "investment") return guess;
  const seen = familyFromActivity(txns);
  if (!seen || seen === named) return guess;
  const business = BUSINESS.test(name);
  if (seen === "bank") return SAVINGS.test(name) ? "savings" : business ? "business_checking" : "checking";
  return business ? "business_credit" : "credit";
}
