import "server-only";
import { and, desc, eq, inArray, sql, type Column } from "drizzle-orm";
import { db } from "@/core/db/client";
import type { Viewer } from "../access";
import { financeAccounts, financeCategoryRules, financeReviewActions, financeTransactions as t, type AccountKind, type ReviewActionKind } from "../schema";

/**
 * The Finance review's change log. Each fix records what it needs to be put
 * back; undo restores it unless the row was changed again since (then that
 * row is left as it is). A member only sees and undoes their own entries.
 */

export type TxnSnapshot = Omit<typeof t.$inferSelect, "createdAt"> & { createdAt: string };
type Pair = { category: string | null; subcategory: string | null };

export type UndoPayload = {
  merge_account: { fromId: string; intoId: string; moved: string[]; removed: TxnSnapshot[]; wasActive: boolean };
  remove_duplicates: { removed: TxnSnapshot[] };
  rename_account: { accountId: string; before: { displayName: string | null; kind: AccountKind }; after: { displayName: string; kind: AccountKind } };
  deactivate_account: { accountId: string };
  map_categories: { groups: { ids: string[]; from: Pair; to: Pair }[]; rules: { merchant: string; from: Pair; to: Pair }[] };
};

export async function recordReviewAction<K extends ReviewActionKind>(viewer: Viewer, kind: K, summary: string, undo: UndoPayload[K]) {
  const [row] = await db()
    .insert(financeReviewActions)
    .values({ viewer, kind, summary: summary.slice(0, 300), undo })
    .returning({ id: financeReviewActions.id });
  return row.id;
}

export async function listReviewActions(viewer: Viewer, limit = 50) {
  return db()
    .select({
      id: financeReviewActions.id,
      kind: financeReviewActions.kind,
      summary: financeReviewActions.summary,
      status: financeReviewActions.status,
      createdAt: financeReviewActions.createdAt,
    })
    .from(financeReviewActions)
    .where(eq(financeReviewActions.viewer, viewer))
    .orderBy(desc(financeReviewActions.createdAt))
    .limit(limit);
}

async function restoreRows(rows: TxnSnapshot[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
    // Skips a row whose copy came back meanwhile (same account, source and id).
    await db().insert(t).values(chunk).onConflictDoNothing();
  }
}

/** `col IS NOT DISTINCT FROM value`: equal, with null equal to null. */
export const isNotDistinctFrom = (col: Column, value: string | null) => sql`${col} is not distinct from ${value}`;

export const samePair = (p: Pair) => and(isNotDistinctFrom(t.category, p.category), isNotDistinctFrom(t.subcategory, p.subcategory));

export async function undoReviewAction(viewer: Viewer, id: string): Promise<string> {
  const [row] = await db()
    .select()
    .from(financeReviewActions)
    .where(and(eq(financeReviewActions.id, id), eq(financeReviewActions.viewer, viewer)));
  if (!row) throw new Error("Change not found");
  if (row.status === "undone") return "Already undone";

  switch (row.kind) {
    case "merge_account": {
      const u = row.undo as UndoPayload["merge_account"];
      for (let i = 0; i < u.moved.length; i += 500) {
        await db()
          .update(t)
          .set({ accountId: u.fromId })
          .where(and(inArray(t.id, u.moved.slice(i, i + 500)), eq(t.accountId, u.intoId)));
      }
      await restoreRows(u.removed);
      await db().update(financeAccounts).set({ active: u.wasActive }).where(eq(financeAccounts.id, u.fromId));
      break;
    }
    case "remove_duplicates":
      await restoreRows((row.undo as UndoPayload["remove_duplicates"]).removed);
      break;
    case "rename_account": {
      const u = row.undo as UndoPayload["rename_account"];
      await db()
        .update(financeAccounts)
        .set(u.before)
        .where(and(eq(financeAccounts.id, u.accountId), eq(financeAccounts.displayName, u.after.displayName), eq(financeAccounts.kind, u.after.kind)));
      break;
    }
    case "deactivate_account":
      await db().update(financeAccounts).set({ active: true }).where(eq(financeAccounts.id, (row.undo as UndoPayload["deactivate_account"]).accountId));
      break;
    case "map_categories": {
      const u = row.undo as UndoPayload["map_categories"];
      for (const g of u.groups) {
        for (let i = 0; i < g.ids.length; i += 500) {
          await db()
            .update(t)
            .set(g.from)
            .where(and(inArray(t.id, g.ids.slice(i, i + 500)), samePair(g.to)));
        }
      }
      for (const r of u.rules) {
        if (!r.from.category) continue;
        await db()
          .update(financeCategoryRules)
          .set({ category: r.from.category, subcategory: r.from.subcategory, updatedAt: new Date() })
          .where(
            and(
              eq(financeCategoryRules.merchant, r.merchant),
              isNotDistinctFrom(financeCategoryRules.category, r.to.category),
              isNotDistinctFrom(financeCategoryRules.subcategory, r.to.subcategory),
            ),
          );
      }
      break;
    }
  }
  await db().update(financeReviewActions).set({ status: "undone", undoneAt: new Date() }).where(eq(financeReviewActions.id, id));
  return `Undone: ${row.summary}`;
}
