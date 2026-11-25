/**
 * No account or card numbers are stored, not even masked ones (Pavel's rule).
 * Banks often append them to account names: "Freedom Unlimited (...1234)",
 * "CHECKING xxxx5678", "Visa 4111 1111 1111 1111". Runs of four or more
 * digits, with any mask characters and brackets around them, are dropped.
 * A matching SQL expression cleaned existing rows in migration 0010.
 */
const NUMBER_RUN = /\s*[([]?\s*(?:[.*xX#•…-]{2,}|#)?\s*\d(?:[ -]?\d){3,}\s*[)\]]?/g;

export function stripAccountNumbers(name: string, fallback = "Account"): string {
  const out = name.replace(NUMBER_RUN, " ").replace(/\s{2,}/g, " ").trim();
  return out || fallback;
}

/** For names people type (nickname, official name): same rule, empty stays empty. */
export function cleanTypedName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const out = trimmed.replace(NUMBER_RUN, " ").replace(/\s{2,}/g, " ").trim();
  return out || null;
}
