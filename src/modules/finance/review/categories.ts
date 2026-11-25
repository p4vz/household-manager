import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { sanitizePayload } from "@/core/ai/sanitize";
import { db } from "@/core/db/client";
import { visibleTo, type Viewer } from "../access";
import { financeAccounts, financeCategoryRules, financeReviewState, financeTransactions as t } from "../schema";
import { isNotDistinctFrom, recordReviewAction, samePair, type UndoPayload } from "./log";
import { formatPair, isParent, PARENTS, suggestCanonical, TAXONOMY, type CategoryPair } from "./taxonomy";

/**
 * Step 2 of the Finance review: one clean category set. Each category pair in
 * use gets a suggestion: kept when it already fits, mapped by the built-in
 * alias list (Mint and Simplifi names), or proposed by Claude for the rest.
 * Nothing changes until the member presses Apply; the remap is logged and
 * can be undone. Only transactions on accounts the member can see are
 * changed; merchant rules (shared by the household) follow the same mapping.
 */

export type SuggestionSource = "keep" | "built-in" | "claude";
export type CategoryReviewRow = {
  from: CategoryPair;
  count: number;
  total: number;
  merchants: string[];
  suggestion: CategoryPair | null;
  source: SuggestionSource | null;
};

type SavedProposal = { builtAt: string; rows: { from: CategoryPair; suggestion: CategoryPair; source: SuggestionSource }[] };

const pairKey = (p: CategoryPair) => `${p.category ?? ""}\u0000${p.subcategory ?? ""}`;

async function savedProposal(viewer: Viewer): Promise<SavedProposal | null> {
  const [row] = await db().select({ p: financeReviewState.categoryProposal }).from(financeReviewState).where(eq(financeReviewState.viewer, viewer));
  return (row?.p as SavedProposal | null) ?? null;
}

async function saveProposal(viewer: Viewer, p: SavedProposal) {
  await db()
    .insert(financeReviewState)
    .values({ viewer, categoryProposal: p })
    .onConflictDoUpdate({ target: financeReviewState.viewer, set: { categoryProposal: p, updatedAt: new Date() } });
}

/** Category pairs in use on visible transactions, busiest first, with a few example merchants. */
async function pairsInUse(viewer: Viewer) {
  const counts = await db()
    .select({
      category: t.category,
      subcategory: t.subcategory,
      count: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${t.amount}), 0)::float`,
    })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(visibleTo(viewer))
    .groupBy(t.category, t.subcategory)
    .orderBy(desc(sql`count(*)`));
  const merchants = await db()
    .select({ category: t.category, subcategory: t.subcategory, merchant: t.merchant, n: sql<number>`count(*)::int` })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(visibleTo(viewer))
    .groupBy(t.category, t.subcategory, t.merchant)
    .orderBy(desc(sql`count(*)`));
  const top = new Map<string, string[]>();
  for (const m of merchants) {
    const k = pairKey(m);
    const list = top.get(k) ?? [];
    if (list.length < 4) list.push(m.merchant);
    top.set(k, list);
  }
  return counts.map((c) => ({ ...c, merchants: top.get(pairKey(c)) ?? [] }));
}

export async function categoryReview(viewer: Viewer): Promise<{ rows: CategoryReviewRow[]; uncategorized: number; claudeRanAt: string | null }> {
  const pairs = await pairsInUse(viewer);
  const saved = await savedProposal(viewer);
  const fromClaude = new Map((saved?.rows ?? []).filter((r) => r.source === "claude").map((r) => [pairKey(r.from), r.suggestion]));
  let uncategorized = 0;
  const rows: CategoryReviewRow[] = [];
  for (const p of pairs) {
    if (!p.category) {
      uncategorized += p.count;
      continue;
    }
    const from = { category: p.category, subcategory: p.subcategory };
    const built = suggestCanonical(from);
    const same = built && pairKey(built) === pairKey(from);
    const claude = fromClaude.get(pairKey(from)) ?? null;
    rows.push({
      from,
      count: p.count,
      total: Math.round(p.total * 100) / 100,
      merchants: p.merchants,
      suggestion: built ?? claude,
      source: built ? (same ? "keep" : "built-in") : claude ? "claude" : null,
    });
  }
  return { rows, uncategorized, claudeRanAt: saved?.builtAt ?? null };
}

const AiAnswer = z.object({
  items: z.array(z.object({ id: z.number().int(), category: z.enum(PARENTS as [string, ...string[]]), subcategory: z.string().nullable() })),
});

const SYSTEM =
  "You tidy a household's spending categories. Map each old category onto the household's category set: pick one parent and, when one fits, one of that parent's subcategories exactly as written. Use the example merchants to judge. Never invent new categories.";

/** Asks Claude (or the configured AI) about the pairs the built-in list couldn't place. */
export async function proposeCategoriesWithAi(viewer: Viewer, now = new Date()): Promise<{ asked: number; answered: number }> {
  const { rows } = await categoryReview(viewer);
  const open = rows.filter((r) => r.source !== "keep" && r.source !== "built-in");
  const out: SavedProposal["rows"] = [];
  for (let i = 0; i < open.length; i += 100) {
    const chunk = open.slice(i, i + 100);
    const payload = sanitizePayload({
      categorySet: TAXONOMY,
      oldCategories: chunk.map((r, id) => ({ id, category: r.from.category, subcategory: r.from.subcategory, transactions: r.count, exampleMerchants: r.merchants })),
    });
    const answer = await runStructured({
      tier: "flagship",
      system: SYSTEM,
      task: "For every item in oldCategories, return its id with the best parent category and subcategory (null if none fits) from categorySet.",
      payload,
      schema: AiAnswer,
    });
    for (const a of answer.items) {
      const row = chunk[a.id];
      if (!row || !isParent(a.category)) continue;
      const subs = TAXONOMY[a.category] as readonly string[];
      const sub = a.subcategory && subs.includes(a.subcategory) ? a.subcategory : null;
      out.push({ from: row.from, suggestion: { category: a.category, subcategory: sub }, source: "claude" });
    }
  }
  await saveProposal(viewer, { builtAt: now.toISOString(), rows: out });
  return { asked: open.length, answered: out.length };
}

export type CategoryMapping = { from: CategoryPair; to: CategoryPair };

/** Recategorizes visible transactions (and merchant rules) by the given mapping, logged for undo. */
export async function applyCategoryMapping(viewer: Viewer, mappings: CategoryMapping[]) {
  const groups: UndoPayload["map_categories"]["groups"] = [];
  const rules: UndoPayload["map_categories"]["rules"] = [];
  for (const m of mappings) {
    if (!m.from.category || !m.to.category || pairKey(m.from) === pairKey(m.to)) continue;
    if (!isParent(m.to.category)) throw new Error(`"${formatPair(m.to)}" isn't in the category set`);
    const to = { category: m.to.category, subcategory: m.to.subcategory?.trim().slice(0, 60) || null };
    const ids = (
      await db()
        .select({ id: t.id })
        .from(t)
        .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
        .where(and(visibleTo(viewer), samePair(m.from)))
    ).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      await db().update(t).set(to).where(inArray(t.id, ids.slice(i, i + 500)));
    }
    if (ids.length) groups.push({ ids, from: m.from, to });
    const touched = await db()
      .update(financeCategoryRules)
      .set({ category: to.category, subcategory: to.subcategory, updatedAt: new Date() })
      .where(and(isNotDistinctFrom(financeCategoryRules.category, m.from.category), isNotDistinctFrom(financeCategoryRules.subcategory, m.from.subcategory)))
      .returning({ merchant: financeCategoryRules.merchant });
    for (const r of touched) rules.push({ merchant: r.merchant, from: m.from, to });
  }
  const moved = groups.reduce((n, g) => n + g.ids.length, 0);
  if (!groups.length && !rules.length) return { changed: 0, summary: "Nothing to change" };
  const summary = `Recategorized ${moved} transactions across ${groups.length} categories${rules.length ? ` and ${rules.length} merchant rules` : ""}`;
  await recordReviewAction(viewer, "map_categories", summary, { groups, rules });
  return { changed: moved, summary };
}
