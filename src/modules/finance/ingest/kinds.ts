import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/core/db/client";
import { financeAccounts, financeTransactions } from "../schema";
import { accountFamily, inferAccountKind } from "./account-kind";

/** Transactions per account looked at: plenty to see deposits or card payments. */
const SAMPLE = 300;

/**
 * Re-works out the type of every account whose type is still a guess (never
 * one a person set), from its name and recent transactions. Runs after each
 * bank sync and CSV import. Nothing leaves the server and nothing is logged.
 */
export async function refreshGuessedKinds(accountIds?: string[]): Promise<number> {
  if (accountIds && !accountIds.length) return 0;
  const accounts = await db()
    .select({
      id: financeAccounts.id,
      bankName: financeAccounts.bankName,
      officialName: financeAccounts.officialName,
      kind: financeAccounts.kind,
    })
    .from(financeAccounts)
    .where(and(eq(financeAccounts.kindSource, "guess"), accountIds ? inArray(financeAccounts.id, accountIds) : undefined));
  let changed = 0;
  for (const a of accounts) {
    const txns = await db()
      .select({ amount: financeTransactions.amount, description: financeTransactions.description })
      .from(financeTransactions)
      .where(eq(financeTransactions.accountId, a.id))
      .orderBy(desc(financeTransactions.postedDate))
      .limit(SAMPLE);
    const kind = inferAccountKind(`${a.bankName} ${a.officialName ?? ""}`, txns);
    // Only a real correction: an untyped account getting a type, or a bank
    // account versus card mix-up. A choice within the family (checking or
    // savings) may be someone's edit from before types were tracked.
    if (kind === "other" || kind === a.kind) continue;
    if (a.kind !== "other" && accountFamily(a.kind) === accountFamily(kind)) continue;
    await db()
      .update(financeAccounts)
      .set({ kind })
      .where(and(eq(financeAccounts.id, a.id), eq(financeAccounts.kindSource, "guess")));
    changed++;
  }
  return changed;
}
