import "server-only";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { visibleTo, type Viewer } from "./access";
import {
  financeAccounts,
  financeTransactionLinks as l,
  financeTransactions as t,
  type LinkSource,
  type LinkStatus,
} from "./schema";

/**
 * Links between bank transactions and things in other modules (a trip and
 * its itinerary steps, an upkeep task). See `financeTransactionLinks`.
 *
 * Every read and write here takes the viewer first, like the rest of
 * finance: a member can only see, link or unlink transactions on joint
 * accounts or their own. The single exception is `autoLinkTransactions`,
 * which the background matcher uses; it only adds links and never returns
 * transaction data, so nothing private is shown to anyone by it.
 */

export type TransactionLink = {
  targetId: string;
  detailId: string | null;
  status: LinkStatus;
  source: LinkSource;
};

const accountName = sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`;

const candidateColumns = {
  id: t.id,
  date: t.postedDate,
  merchant: t.merchant,
  description: t.description,
  amount: t.amount,
  category: t.category,
  subcategory: t.subcategory,
  pending: t.pending,
  accountId: t.accountId,
  account: accountName,
  accountKind: financeAccounts.kind,
  owner: financeAccounts.owner,
  linkTargetId: l.targetId,
  linkDetailId: l.detailId,
  linkStatus: l.status,
  linkSource: l.source,
};

type CandidateRow = {
  id: string;
  date: string;
  merchant: string;
  description: string;
  amount: number;
  category: string | null;
  subcategory: string | null;
  pending: boolean;
  accountId: string;
  account: string;
  accountKind: string;
  owner: "user1" | "user2" | "joint";
  linkTargetId: string | null;
  linkDetailId: string | null;
  linkStatus: LinkStatus | null;
  linkSource: LinkSource | null;
};

export type LinkableTransaction = Omit<CandidateRow, "linkTargetId" | "linkDetailId" | "linkStatus" | "linkSource"> & {
  link: TransactionLink | null;
};

function shape(rows: CandidateRow[]): LinkableTransaction[] {
  return rows.map(({ linkTargetId, linkDetailId, linkStatus, linkSource, ...r }) => ({
    ...r,
    amount: Number(r.amount),
    link: linkTargetId ? { targetId: linkTargetId, detailId: linkDetailId, status: linkStatus!, source: linkSource! } : null,
  }));
}

async function candidates(where: ReturnType<typeof and>, module: string) {
  const rows = await db()
    .select(candidateColumns)
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .leftJoin(l, and(eq(l.transactionId, t.id), eq(l.module, module)))
    .where(where)
    .orderBy(asc(t.postedDate), asc(t.merchant));
  return shape(rows as CandidateRow[]);
}

/**
 * Spending and refunds (no transfers) between two dates that this member can
 * see, each with its current link for `module`. Used to suggest matches.
 */
export function linkCandidates(viewer: Viewer, module: string, range: { from: string; to: string }) {
  return candidates(and(visibleTo(viewer), eq(t.isTransfer, false), gte(t.postedDate, range.from), lte(t.postedDate, range.to)), module);
}

/** Transactions linked (not dismissed) to these targets, visible to this member. */
export function linkedTransactions(viewer: Viewer, module: string, targetIds: string[]) {
  if (!targetIds.length) return Promise.resolve([] as LinkableTransaction[]);
  return candidates(and(visibleTo(viewer), eq(l.status, "linked"), inArray(l.targetId, targetIds)), module);
}

/** The visible transactions among `ids`, with their link for `module`. */
export function transactionsWithLinks(viewer: Viewer, module: string, ids: string[]) {
  if (!ids.length) return Promise.resolve([] as LinkableTransaction[]);
  return candidates(and(visibleTo(viewer), inArray(t.id, ids)), module);
}

async function assertVisible(viewer: Viewer, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const rows = await db()
    .select({ id: t.id })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(and(visibleTo(viewer), inArray(t.id, unique)));
  if (rows.length !== unique.length) throw new Error("Transaction not found");
}

/** Links (or dismisses) transactions for a module, replacing any link they had there. */
export async function setTransactionLinks(viewer: Viewer, module: string, ids: string[], link: TransactionLink) {
  await assertVisible(viewer, ids);
  if (!ids.length) return;
  const values = [...new Set(ids)].map((transactionId) => ({ transactionId, module, ...link }));
  await db()
    .insert(l)
    .values(values)
    .onConflictDoUpdate({
      target: [l.transactionId, l.module],
      set: { targetId: link.targetId, detailId: link.detailId, status: link.status, source: link.source, createdAt: new Date() },
    });
}

/** Removes the module's link from these transactions (back to "not looked at"). */
export async function clearTransactionLinks(viewer: Viewer, module: string, ids: string[]) {
  await assertVisible(viewer, ids);
  if (!ids.length) return;
  await db().delete(l).where(and(eq(l.module, module), inArray(l.transactionId, ids)));
}

/**
 * Background matching: adds links for transactions that have none in this
 * module yet. It never replaces a link a person made or dismissed. Returns
 * how many were added; no transaction data leaves this function.
 */
export async function autoLinkTransactions(module: string, links: { transactionId: string; targetId: string; detailId: string | null }[]) {
  if (!links.length) return 0;
  const added = await db()
    .insert(l)
    .values(links.map((x) => ({ ...x, module, status: "linked" as const, source: "auto" as const })))
    .onConflictDoNothing()
    .returning({ id: l.transactionId });
  return added.length;
}

/**
 * Every transaction in a date range, for background matching only. Its rows
 * must never be shown or sent anywhere: callers turn them into
 * `autoLinkTransactions` calls and drop them.
 */
export function householdLinkCandidates(module: string, range: { from: string; to: string }) {
  return candidates(and(eq(t.isTransfer, false), gte(t.postedDate, range.from), lte(t.postedDate, range.to)), module);
}
