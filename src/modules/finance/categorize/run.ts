import "server-only";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { sanitizePayload } from "@/core/ai/sanitize";
import { db } from "@/core/db/client";
import { stripAccountNumbers } from "../ingest/redact";
import {
  financeAccounts as a,
  financeCategoryRules,
  financeExpectedExpenses,
  financeSubscriptions,
  financeTransactions as t,
  type AccountKind,
  type CategorySource,
} from "../schema";
import { PARENTS } from "../review/taxonomy";
import {
  buildIndex,
  CONFIDENT,
  decide,
  effectiveSource,
  type Decision,
  type HistoryTxn,
  type Index,
  type Rule,
  type Target,
} from "./engine";

/** History older than this rarely says anything about today's charges. */
const HISTORY_YEARS = 4;
/** Synced rows categorized before this change are re-checked against history this far back. */
const RECHECK_DAYS = 120;
const AI_BATCH = 60;
const AI_MAX_PER_RUN = 240;

export type CategorizeResult = {
  /** Total transactions given a category in this run. */
  categorized: number;
  fromHistory: number;
  byAi: number;
  /** Earlier vendor-name-only categories corrected from history. */
  corrected: number;
  /** Left for a person: Claude unavailable, or not sure either. */
  undecided: number;
  batches: number;
};

const columns = {
  id: t.id,
  merchant: t.merchant,
  description: t.description,
  memo: t.memo,
  amount: t.amount,
  date: t.postedDate,
  accountId: t.accountId,
  accountKind: a.kind,
  owner: a.owner,
  category: t.category,
  subcategory: t.subcategory,
  categorySource: t.categorySource,
  source: t.source,
  pending: t.pending,
};

async function loadIndex(today: string): Promise<Index> {
  const since = shiftDays(today, -365 * HISTORY_YEARS);
  const rows = await db()
    .select(columns)
    .from(t)
    .innerJoin(a, eq(a.id, t.accountId))
    .where(and(eq(t.isTransfer, false), gte(t.postedDate, since)));
  const history: HistoryTxn[] = rows.map((r) => ({ ...r, source: effectiveSource(r) }));
  const recent = shiftDays(today, -800);
  const charges = rows.filter((r) => r.date >= recent).map((r) => ({ owner: r.owner, postedDate: r.date, amount: r.amount, merchant: r.merchant }));
  const ruleRows = await db().select().from(financeCategoryRules);
  const rules = new Map<string, Rule>(ruleRows.map((r) => [r.merchant, { category: r.category, subcategory: r.subcategory, source: r.source }]));
  const subscriptions = await db().select({ merchantKey: financeSubscriptions.merchantKey, status: financeSubscriptions.status }).from(financeSubscriptions);
  const expected = await db()
    .select({ title: financeExpectedExpenses.title, date: financeExpectedExpenses.date, amount: financeExpectedExpenses.amount, category: financeExpectedExpenses.category })
    .from(financeExpectedExpenses);
  return buildIndex({ history, charges, rules, subscriptions, expected, today });
}

function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function applyDecision(id: string, d: { category: string; subcategory: string | null; reason: string }, source: CategorySource, onlyIfSource?: CategorySource[]) {
  const where = onlyIfSource
    ? and(eq(t.id, id), inArray(t.categorySource, onlyIfSource))
    : and(eq(t.id, id), isNull(t.category));
  const res = await db()
    .update(t)
    .set({ category: d.category, subcategory: d.subcategory, categorySource: source, categoryReason: d.reason.slice(0, 300) })
    .where(where)
    .returning({ id: t.id });
  return res.length;
}

/**
 * Categorize every uncategorized transaction from what is already known:
 * past transactions (imported history first), merchant rules, recurring
 * charges, subscriptions and expected costs. Then, when `ai` is on, ask
 * Claude about the ones history can't settle, with the evidence attached.
 *
 * Also re-checks recently synced rows that were categorized from the
 * merchant name alone (before this existed), and corrects them when trusted
 * history clearly disagrees. Manual edits are never touched.
 */
export async function categorizeTransactions(opts: { ai: boolean; now?: Date }): Promise<CategorizeResult> {
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const result: CategorizeResult = { categorized: 0, fromHistory: 0, byAi: 0, corrected: 0, undecided: 0, batches: 0 };

  const pendingRows = await db()
    .select(columns)
    .from(t)
    .innerJoin(a, eq(a.id, t.accountId))
    .where(
      and(
        eq(t.isTransfer, false),
        or(
          isNull(t.category),
          and(eq(t.source, "simplefin"), inArray(t.categorySource, ["legacy", "ai"]), gte(t.postedDate, shiftDays(today, -RECHECK_DAYS))),
        ),
      ),
    );
  if (pendingRows.length === 0) return result;

  const targets: (Target & { current: string | null; currentSource: CategorySource | null })[] = pendingRows.map((r) => ({
    id: r.id,
    merchant: r.merchant,
    description: r.description,
    memo: r.memo,
    amount: r.amount,
    date: r.date,
    accountId: r.accountId,
    accountKind: r.accountKind,
    owner: r.owner,
    pending: r.pending,
    current: r.category,
    currentSource: r.category ? effectiveSource(r) : null,
  }));
  const index = await loadIndex(today);

  const ambiguous: { target: Target; decision: Decision }[] = [];
  for (const target of targets) {
    if (target.current) {
      // Already categorized from the name alone: change it only on trusted evidence.
      const d = decide(target, index, { trustedOnly: true });
      if (d.category && d.confidence >= CONFIDENT && d.category !== target.current) {
        result.corrected += await applyDecision(target.id, d as Decision & { category: string }, "history", ["legacy", "ai"]);
      }
      continue;
    }
    const d = decide(target, index);
    if (d.category && d.confidence >= CONFIDENT) {
      result.fromHistory += await applyDecision(target.id, d as Decision & { category: string }, "history");
    } else {
      ambiguous.push({ target, decision: d });
    }
  }

  if (opts.ai && ambiguous.length > 0) {
    const knownCats = await db().selectDistinct({ category: t.category }).from(t).where(sql`${t.category} is not null`);
    const categories = [...new Set([...PARENTS, ...knownCats.map((k) => k.category!)])].sort();
    const work = ambiguous.slice(0, AI_MAX_PER_RUN);
    for (let i = 0; i < work.length; i += AI_BATCH) {
      const batch = work.slice(i, i + AI_BATCH);
      const answers = await askClaude(batch, categories);
      result.batches++;
      for (const ans of answers) {
        const item = batch[ans.id];
        if (!item || !ans.category || !categories.includes(ans.category)) continue; // ignore anything invented
        const why = item.decision.reason !== "no similar history" ? `Claude, from: ${item.decision.reason}` : "Claude";
        result.byAi += await applyDecision(item.target.id, { category: ans.category, subcategory: ans.subcategory, reason: why }, "ai");
      }
    }
  }
  result.categorized = result.fromHistory + result.byAi;
  result.undecided = ambiguous.length - result.byAi;
  return result;
}

const ACCOUNT_TYPE: Record<AccountKind, string> = {
  credit: "credit card",
  business_credit: "business credit card",
  checking: "checking",
  business_checking: "business checking",
  savings: "savings",
  loan: "loan",
  investment: "investment",
  other: "other",
};

/**
 * What Claude sees for one transaction. Merchant, description and memo (with
 * account numbers stripped, then scrubbed again by sanitizePayload), the
 * amount, the kind of account (never its name, number or last 4 digits),
 * pending, how often it repeats, and what similar past transactions were.
 * No dates, owners or account identifiers.
 */
export function aiItem(id: number, target: Target, d: Decision) {
  const merchant = stripAccountNumbers(target.merchant, "Unknown");
  const description = stripAccountNumbers(target.description, "");
  const memo = target.memo ? stripAccountNumbers(target.memo, "") : "";
  return {
    id,
    merchant,
    ...(description && description.toLowerCase() !== merchant.toLowerCase() ? { description } : {}),
    ...(memo ? { memo } : {}),
    amount: Math.round(target.amount * 100) / 100,
    accountType: ACCOUNT_TYPE[target.accountKind],
    pending: target.pending,
    repeats: d.recurring,
    similarPast: d.candidates.map((c) => ({ category: c.category, subcategory: c.subcategory, share: c.share })),
  };
}

export function buildAiPayload(batch: { target: Target; decision: Decision }[], categories: string[]) {
  // Referred to by index: scrubbing may change the text.
  return sanitizePayload({ categories, transactions: batch.map((b, i) => aiItem(i, b.target, b.decision)) });
}

async function askClaude(batch: { target: Target; decision: Decision }[], categories: string[]) {
  const Result = z.object({
    assignments: z.array(
      z.object({
        id: z.number().int(),
        category: z.string().nullable(),
        subcategory: z.string().nullable(),
      }),
    ),
  });
  const { assignments } = await runStructured({
    tier: "fast",
    system:
      "You categorize household bank and credit card transactions. Use everything given: merchant, description, memo, amount (negative is money out, positive is money in), account type, whether it is pending, how often it repeats, and similarPast (categories this household gave similar past transactions, with their share). Prefer the household's own history when it fits the amount and description. A steady charge that repeats monthly or yearly is usually a subscription or a bill. Money in from a store is usually a refund in the purchase's category. Pick exactly one category from the list, plus a short subcategory when obvious. Return category null when you genuinely cannot tell.",
    task: "Categorize every transaction in DATA.transactions. Return one assignment per transaction, identified by its id.",
    payload: buildAiPayload(batch, categories),
    schema: Result,
  });
  return assignments;
}
