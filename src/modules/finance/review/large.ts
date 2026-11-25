import "server-only";
import { and, asc, desc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { HiddenAccountError, visibleTo, type Viewer } from "../access";
import { financeAccounts, financeReviewQuestions as q, financeReviewState, financeTransactions as t } from "../schema";

/**
 * Step 3 of the Finance review: large purchases nobody has explained yet.
 * The member answers "What was this for?" (or skips one, or a whole
 * merchant); answered and skipped purchases are not asked about again.
 * Turning answers into house upkeep happens outside finance
 * (src/assistant/review.ts), through the normal module APIs.
 */

export const DEFAULT_LARGE_THRESHOLD = 500;

/** Spending that is large but never a question: housing payments, loans, card payments. */
const ROUTINE_SUBCATEGORIES = ["Mortgage & Rent", "Car Payment", "Loan Payment", "Credit Card Payment", "Student Loan"];
const NOT_SPENDING = ["Transfer", "Income"];

const accountName = sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`;

export async function largeThreshold(viewer: Viewer): Promise<number> {
  const [row] = await db().select({ v: financeReviewState.largeThreshold }).from(financeReviewState).where(eq(financeReviewState.viewer, viewer));
  return row?.v ?? DEFAULT_LARGE_THRESHOLD;
}

export async function setLargeThreshold(viewer: Viewer, amount: number) {
  const v = Math.min(Math.max(Math.round(amount), 50), 100_000);
  await db()
    .insert(financeReviewState)
    .values({ viewer, largeThreshold: v })
    .onConflictDoUpdate({ target: financeReviewState.viewer, set: { largeThreshold: v, updatedAt: new Date() } });
  return v;
}

const columns = {
  id: t.id,
  date: t.postedDate,
  merchant: t.merchant,
  description: t.description,
  amount: t.amount,
  category: t.category,
  subcategory: t.subcategory,
  notes: t.notes,
  account: accountName,
  owner: financeAccounts.owner,
};

function largeWhere(viewer: Viewer, threshold: number) {
  return and(
    visibleTo(viewer),
    lte(t.amount, -threshold),
    eq(t.isTransfer, false),
    eq(t.pending, false),
    or(isNull(t.category), notInArray(t.category, NOT_SPENDING)),
    or(isNull(t.subcategory), notInArray(t.subcategory, ROUTINE_SUBCATEGORIES)),
  );
}

export type LargePurchase = Awaited<ReturnType<typeof largePurchases>>["open"][number];

/** Open questions (newest first) and the ones already answered or skipped. */
export async function largePurchases(viewer: Viewer, threshold: number, limit = 60) {
  const open = await db()
    .select(columns)
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .leftJoin(q, eq(q.transactionId, t.id))
    .where(and(largeWhere(viewer, threshold), isNull(q.transactionId)))
    .orderBy(desc(t.postedDate), asc(t.merchant))
    .limit(limit + 1);
  const [{ n }] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .leftJoin(q, eq(q.transactionId, t.id))
    .where(and(largeWhere(viewer, threshold), isNull(q.transactionId)));
  const done = await db()
    .select({ ...columns, status: q.status, answer: q.answer, outcome: q.outcome, answeredAt: q.answeredAt })
    .from(q)
    .innerJoin(t, eq(q.transactionId, t.id))
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(visibleTo(viewer))
    .orderBy(desc(q.answeredAt))
    .limit(100);
  return { open: open.slice(0, limit), openCount: n, done };
}

/** One visible transaction for the large-purchase flow, or an error if hidden. */
export async function reviewTransaction(viewer: Viewer, id: string) {
  const [row] = await db()
    .select(columns)
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(and(eq(t.id, id), visibleTo(viewer)));
  if (!row) throw new HiddenAccountError();
  return row;
}

export async function recordLargePurchaseAnswer(
  viewer: Viewer,
  transactionId: string,
  status: "answered" | "dismissed",
  answer: string | null,
  outcome: { summary: string; changesetId: string | null } | null,
) {
  await reviewTransaction(viewer, transactionId);
  const values = { viewer, status, answer, outcome, answeredAt: new Date() };
  await db()
    .insert(q)
    .values({ transactionId, ...values })
    .onConflictDoUpdate({ target: q.transactionId, set: values });
}

/** Skips every open large purchase at one merchant ("that's the mortgage company"). */
export async function dismissLargePurchasesAt(viewer: Viewer, merchant: string, threshold: number) {
  const rows = await db()
    .select({ id: t.id })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .leftJoin(q, eq(q.transactionId, t.id))
    .where(and(largeWhere(viewer, threshold), isNull(q.transactionId), eq(t.merchant, merchant)));
  if (!rows.length) return 0;
  await db()
    .insert(q)
    .values(rows.map((r) => ({ transactionId: r.id, viewer, status: "dismissed" as const, answer: null, outcome: null })))
    .onConflictDoNothing();
  return rows.length;
}

/** Asks again about a purchase (undoes an answer or a skip; edits stay in Ask Claude history). */
export async function reopenLargePurchase(viewer: Viewer, transactionId: string) {
  await reviewTransaction(viewer, transactionId);
  await db().delete(q).where(and(eq(q.transactionId, transactionId), inArray(q.viewer, ["user1", "user2"])));
}
