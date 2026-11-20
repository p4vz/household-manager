import "server-only";
import { redirect } from "next/navigation";
import { auth } from "./config";
import { isAllowedEmail, ownerLabelFor, parseAllowlist, type OwnerLabel } from "./allowlist";

export type HouseholdUser = { email: string; owner: OwnerLabel };

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
  }
}

/** Returns the signed-in household member, or null. */
export async function currentUser(): Promise<HouseholdUser | null> {
  const session = await auth();
  const email = session?.user?.email;
  const allowlist = parseAllowlist(process.env.ALLOWED_EMAILS);
  if (!email || !isAllowedEmail(email, allowlist)) return null;
  const owner = ownerLabelFor(email, allowlist);
  return owner ? { email: email.toLowerCase(), owner } : null;
}

/** For server actions and route handlers: throws if not an allowlisted user. */
export async function requireUser(): Promise<HouseholdUser> {
  const user = await currentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/** For pages and layouts: redirects to sign-in if not an allowlisted user. */
export async function requireUserOrRedirect(): Promise<HouseholdUser> {
  const user = await currentUser();
  if (!user) redirect("/signin");
  return user;
}
