import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/core/db/client";
import { householdTimeZone, zonedParts } from "@/core/time/zoned";
import { canSeeOwner, type Viewer } from "./access";
import { computeNetWorth, historyDates, type NetWorth } from "./net-worth-compute";
import {
  financeAccounts,
  financeBalanceSnapshots,
  financeNetWorthItems,
  financeNetWorthValues,
  financeTransactions,
  type NetWorthItemKind,
  type Owner,
} from "./schema";

/**
 * Which net worth to show. Each member sees the joint one and their own;
 * nobody sees the other member's (Pavel, 2026-11-25).
 */
export type NetWorthScope = "joint" | "mine" | "both";

export function scopeOwners(viewer: Viewer, scope: NetWorthScope): Owner[] {
  if (scope === "joint") return ["joint"];
  if (scope === "mine") return [viewer];
  return ["joint", viewer];
}

const MONTHS = 24;

export async function netWorth(viewer: Viewer, scope: NetWorthScope, today: string): Promise<NetWorth & { missingBalances: string[] }> {
  const owners = scopeOwners(viewer, scope);
  const accountRows = await db()
    .select({
      id: financeAccounts.id,
      owner: financeAccounts.owner,
      kind: financeAccounts.kind,
      displayName: financeAccounts.displayName,
      officialName: financeAccounts.officialName,
      bankName: financeAccounts.bankName,
      balance: financeAccounts.balance,
      balanceDate: financeAccounts.balanceDate,
    })
    .from(financeAccounts)
    .where(and(inArray(financeAccounts.owner, owners), eq(financeAccounts.active, true)));
  const name = (a: (typeof accountRows)[number]) => a.displayName ?? a.officialName ?? a.bankName;
  const withBalance = accountRows.filter((a) => a.balance != null);
  const accounts = withBalance.map((a) => ({
    id: a.id,
    owner: a.owner,
    kind: a.kind,
    name: name(a),
    balance: a.balance!,
    balanceOn: a.balanceDate ? zonedParts(a.balanceDate, householdTimeZone()).date : today,
  }));
  const ids = accounts.map((a) => a.id);
  const since = historyDates(today, MONTHS)[0];
  const [snapshots, txns] = ids.length
    ? await Promise.all([
        db().select().from(financeBalanceSnapshots).where(and(inArray(financeBalanceSnapshots.accountId, ids), gt(financeBalanceSnapshots.date, since))),
        db()
          .select({ accountId: financeTransactions.accountId, date: financeTransactions.postedDate, amount: financeTransactions.amount })
          .from(financeTransactions)
          .where(and(inArray(financeTransactions.accountId, ids), eq(financeTransactions.pending, false))),
      ])
    : [[], []];
  const items = await db().select().from(financeNetWorthItems).where(inArray(financeNetWorthItems.owner, owners));
  const values = items.length
    ? await db().select().from(financeNetWorthValues).where(inArray(financeNetWorthValues.itemId, items.map((i) => i.id)))
    : [];
  const result = computeNetWorth({ owners, accounts, snapshots, txns, items, values, today, months: MONTHS });
  return { ...result, missingBalances: accountRows.filter((a) => a.balance == null).map(name) };
}

// ---------- hand-entered assets and liabilities ----------

async function ownedItem(viewer: Viewer, id: string) {
  const [row] = await db().select().from(financeNetWorthItems).where(eq(financeNetWorthItems.id, id));
  if (!row || !canSeeOwner(viewer, row.owner)) throw new Error("That item is not available to you");
  return row;
}

export async function listNetWorthItems(viewer: Viewer) {
  const items = await db().select().from(financeNetWorthItems).where(inArray(financeNetWorthItems.owner, ["joint", viewer]));
  const values = items.length
    ? await db().select().from(financeNetWorthValues).where(inArray(financeNetWorthValues.itemId, items.map((i) => i.id)))
    : [];
  return items.map((i) => {
    const mine = values.filter((v) => v.itemId === i.id).sort((a, b) => b.asOf.localeCompare(a.asOf));
    return { ...i, value: mine[0]?.value ?? null, asOf: mine[0]?.asOf ?? null, history: mine };
  });
}

export type NetWorthItemInput = {
  owner: Owner;
  kind: NetWorthItemKind;
  name: string;
  acquiredOn: string | null;
  closedOn: string | null;
  notes: string | null;
};

export async function addNetWorthItem(viewer: Viewer, input: NetWorthItemInput, value: number, asOf: string) {
  if (!canSeeOwner(viewer, input.owner)) throw new Error("Choose Joint or yourself");
  const [row] = await db().insert(financeNetWorthItems).values(input).returning({ id: financeNetWorthItems.id });
  await setNetWorthValue(viewer, row.id, value, asOf);
  return row.id;
}

export async function updateNetWorthItem(viewer: Viewer, id: string, patch: Partial<NetWorthItemInput>) {
  await ownedItem(viewer, id);
  if (patch.owner && !canSeeOwner(viewer, patch.owner)) throw new Error("Choose Joint or yourself");
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (Object.keys(set).length) await db().update(financeNetWorthItems).set(set).where(eq(financeNetWorthItems.id, id));
}

/** Records the value on a date (one per day; a second update the same day replaces it). */
export async function setNetWorthValue(viewer: Viewer, id: string, value: number, asOf: string) {
  await ownedItem(viewer, id);
  await db()
    .insert(financeNetWorthValues)
    .values({ itemId: id, asOf, value })
    .onConflictDoUpdate({ target: [financeNetWorthValues.itemId, financeNetWorthValues.asOf], set: { value } });
}

export async function deleteNetWorthItem(viewer: Viewer, id: string) {
  await ownedItem(viewer, id);
  await db().delete(financeNetWorthItems).where(eq(financeNetWorthItems.id, id));
}
