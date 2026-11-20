/**
 * Pure allowlist logic, shared by the Auth.js signIn callback, the session
 * callback, the request proxy, and every server action / route handler.
 * Exact, case-insensitive match on the full address. No domains, no wildcards.
 */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email: unknown, allowlist: readonly string[]): boolean {
  if (typeof email !== "string" || email.length === 0) return false;
  const normalized = email.trim().toLowerCase();
  return allowlist.includes(normalized);
}

/** Household members are labelled by allowlist position, never by name. */
export type OwnerLabel = "User 1" | "User 2";

export function ownerLabelFor(email: string, allowlist: readonly string[]): OwnerLabel | null {
  const idx = allowlist.indexOf(email.trim().toLowerCase());
  if (idx === 0) return "User 1";
  if (idx === 1) return "User 2";
  return null;
}
