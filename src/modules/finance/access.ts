import { inArray } from "drizzle-orm";
import { financeAccounts, type Owner } from "./schema";

/**
 * Who is looking at finance data. Every read that touches accounts or
 * transactions takes one: a viewer sees joint accounts and their own, never
 * the other member's personal accounts (Pavel, 2026-11-25). Only the account
 * list on the Accounts page shows every account, by name and owner, so both
 * members know what exists; it never shows the other's balance.
 *
 * `user1` / `user2` follow ALLOWED_EMAILS order (the sign-in's OwnerLabel).
 */
export type Viewer = "user1" | "user2";

export const VIEWERS: readonly Viewer[] = ["user1", "user2"];

export function viewerFromLabel(label: "User 1" | "User 2"): Viewer {
  return label === "User 1" ? "user1" : "user2";
}

/** Owners whose accounts this viewer may see in Finance. */
export function visibleOwners(viewer: Viewer): Owner[] {
  return ["joint", viewer];
}

export function canSeeOwner(viewer: Viewer, owner: Owner | string): boolean {
  return owner === "joint" || owner === viewer;
}

/** SQL condition: the account row is visible to this viewer. */
export function visibleTo(viewer: Viewer) {
  return inArray(financeAccounts.owner, visibleOwners(viewer));
}

export class HiddenAccountError extends Error {
  constructor() {
    super("That account is not available to you");
  }
}
