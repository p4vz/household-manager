import "server-only";
import { and, asc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { householdTimeZone } from "@/core/time/zoned";
import { assertNoCardNumber } from "./guard";
import { clearBoughtItems } from "./shopping";
import { pruneOldSuggestions } from "./mail";
import {
  familyChoreCompletions,
  familyChores,
  familyKids,
  familyPurchaseReturns,
} from "./schema";
import { computeKidStats, type KidStats } from "./stats";
import { addDays, bucketFor, dayBucket, householdToday, weekBucket, type Recurrence } from "./time";

/**
 * Family hub public API: kids' chores with completion history, shopping
 * lists (stores, templates, deferral; see shopping.ts), and purchase returns. Used by the kitchen kiosk and the
 * phone view (app routes) only; other modules have no need for it yet.
 */
export const RECURRENCES = ["daily", "weekly", "once"] as const satisfies readonly Recurrence[];
export const RETURN_STATUSES = ["pending", "packed_in_car", "returned"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const CHORE_ICONS = ["🛏️", "🦷", "🧸", "🍽️", "🐶", "📚", "🧺", "🗑️", "🌱", "👕", "🎒", "🚿", "🎹", "🧹", "🥪", "✏️"] as const;
export const KID_COLORS = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2"] as const;

export { deadlineUrgency, type Urgency } from "./time";
export { SensitiveTextError } from "./guard";

const tz = () => householdTimeZone();

// ---------------------------------------------------------------- kids ----

export async function listKids() {
  return db().select().from(familyKids).where(eq(familyKids.active, true)).orderBy(asc(familyKids.sortOrder), asc(familyKids.createdAt));
}

export async function addKid(input: { name: string; color?: string; emoji?: string }) {
  const existing = await listKids();
  const [kid] = await db()
    .insert(familyKids)
    .values({
      name: input.name.trim().slice(0, 30),
      color: input.color ?? KID_COLORS[existing.length % KID_COLORS.length],
      emoji: input.emoji ?? "⭐",
      sortOrder: existing.length,
    })
    .returning({ id: familyKids.id });
  return kid.id;
}

export async function updateKid(id: string, input: { name?: string; color?: string; emoji?: string }) {
  await db()
    .update(familyKids)
    .set({
      ...(input.name !== undefined && { name: input.name.trim().slice(0, 30) }),
      ...(input.color !== undefined && { color: input.color }),
      ...(input.emoji !== undefined && { emoji: input.emoji }),
    })
    .where(eq(familyKids.id, id));
}

/** Hides a kid from the board; their history stays. */
export async function removeKid(id: string) {
  await db().update(familyKids).set({ active: false }).where(eq(familyKids.id, id));
}

// -------------------------------------------------------------- chores ----

export async function addChore(input: { kidId: string; title: string; icon?: string; recurrence: Recurrence; stars?: number }, now = new Date()) {
  const [kid] = await db().select({ id: familyKids.id }).from(familyKids).where(and(eq(familyKids.id, input.kidId), eq(familyKids.active, true)));
  if (!kid) throw new Error("Kid not found");
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(familyChores).where(eq(familyChores.kidId, input.kidId));
  const [chore] = await db()
    .insert(familyChores)
    .values({
      kidId: input.kidId,
      title: input.title.trim().slice(0, 60),
      icon: input.icon ?? "✅",
      recurrence: input.recurrence,
      stars: Math.min(5, Math.max(1, input.stars ?? 1)),
      sortOrder: n,
      createdAt: now,
    })
    .returning({ id: familyChores.id });
  return chore.id;
}

export async function archiveChore(id: string, now = new Date()) {
  await db().update(familyChores).set({ archivedAt: now }).where(eq(familyChores.id, id));
}

/** Ticks a chore for its current period. Ticking twice changes nothing. */
export async function completeChore(choreId: string, now = new Date()) {
  const [chore] = await db().select().from(familyChores).where(and(eq(familyChores.id, choreId), isNull(familyChores.archivedAt)));
  if (!chore) throw new Error("Chore not found");
  await db()
    .insert(familyChoreCompletions)
    .values({
      kidId: chore.kidId,
      choreId: chore.id,
      completedAt: now,
      dateBucket: bucketFor(chore.recurrence, now, tz()),
      stars: chore.stars,
    })
    .onConflictDoNothing();
}

/** Un-ticks a chore for its current period (a mis-tap). */
export async function undoChore(choreId: string, now = new Date()) {
  const [chore] = await db().select().from(familyChores).where(eq(familyChores.id, choreId));
  if (!chore) return;
  const bucket = chore.recurrence === "once" ? null : bucketFor(chore.recurrence, now, tz());
  await db()
    .delete(familyChoreCompletions)
    .where(
      and(
        eq(familyChoreCompletions.choreId, choreId),
        bucket ? eq(familyChoreCompletions.dateBucket, bucket) : gte(familyChoreCompletions.dateBucket, dayBucket(now, tz())),
      ),
    );
}

export type BoardChore = { id: string; title: string; icon: string; recurrence: Recurrence; stars: number; done: boolean };
export type BoardKid = { id: string; name: string; color: string; emoji: string; chores: BoardChore[]; stats: KidStats };

/**
 * The chore board as it stands now: each kid's daily, weekly and open
 * one-time chores, done or not for the current period, with stats. A
 * one-time chore stays on the board for the rest of the chore day it was
 * done, then drops off.
 */
export async function choreBoard(now = new Date()): Promise<BoardKid[]> {
  const zone = tz();
  const today = dayBucket(now, zone);
  const weekStart = weekBucket(now, zone);
  const historyFrom = addDays(today, -60);
  const kids = await listKids();
  if (kids.length === 0) return [];
  const kidIds = kids.map((k) => k.id);

  const [chores, completions, totals] = await Promise.all([
    db()
      .select()
      .from(familyChores)
      .where(
        and(
          inArray(familyChores.kidId, kidIds),
          or(isNull(familyChores.archivedAt), gte(familyChores.archivedAt, new Date(now.getTime() - 61 * 86_400_000))),
        ),
      )
      .orderBy(asc(familyChores.sortOrder), asc(familyChores.createdAt)),
    db()
      .select({
        kidId: familyChoreCompletions.kidId,
        choreId: familyChoreCompletions.choreId,
        dateBucket: familyChoreCompletions.dateBucket,
        stars: familyChoreCompletions.stars,
      })
      .from(familyChoreCompletions)
      .where(and(inArray(familyChoreCompletions.kidId, kidIds), gte(familyChoreCompletions.dateBucket, historyFrom))),
    db()
      .select({ kidId: familyChoreCompletions.kidId, stars: sql<number>`coalesce(sum(${familyChoreCompletions.stars}), 0)::int` })
      .from(familyChoreCompletions)
      .where(inArray(familyChoreCompletions.kidId, kidIds))
      .groupBy(familyChoreCompletions.kidId),
  ]);

  // One-time chores: when (if ever) they were done.
  const onceDoneOn = new Map<string, string>();
  const onceIds = chores.filter((c) => c.recurrence === "once").map((c) => c.id);
  if (onceIds.length) {
    const rows = await db()
      .select({ choreId: familyChoreCompletions.choreId, dateBucket: familyChoreCompletions.dateBucket })
      .from(familyChoreCompletions)
      .where(inArray(familyChoreCompletions.choreId, onceIds));
    for (const r of rows) onceDoneOn.set(r.choreId, r.dateBucket);
  }

  const doneKeys = new Set(completions.map((c) => `${c.choreId}|${c.dateBucket}`));

  return kids.map((kid) => {
    const mine = chores.filter((c) => c.kidId === kid.id);
    const board: BoardChore[] = [];
    for (const c of mine) {
      if (c.archivedAt) continue;
      let done: boolean;
      if (c.recurrence === "once") {
        const on = onceDoneOn.get(c.id);
        if (on && on < today) continue;
        done = Boolean(on);
      } else {
        done = doneKeys.has(`${c.id}|${c.recurrence === "weekly" ? weekStart : today}`);
      }
      board.push({ id: c.id, title: c.title, icon: c.icon, recurrence: c.recurrence, stars: c.stars, done });
    }
    // Daily first, then weekly, then one-time.
    const order: Record<Recurrence, number> = { daily: 0, weekly: 1, once: 2 };
    board.sort((a, b) => order[a.recurrence] - order[b.recurrence]);

    const stats = computeKidStats({
      chores: mine.map((c) => ({
        id: c.id,
        recurrence: c.recurrence,
        createdDay: dayBucket(c.createdAt, zone),
        archivedDay: c.archivedAt ? dayBucket(c.archivedAt, zone) : null,
      })),
      completions: completions.filter((c) => c.kidId === kid.id),
      today,
      weekStart,
      starsTotal: totals.find((t) => t.kidId === kid.id)?.stars ?? 0,
      todayDone: board.filter((c) => c.done).length,
      todayTotal: board.length,
    });
    return { id: kid.id, name: kid.name, color: kid.color, emoji: kid.emoji, chores: board, stats };
  });
}

// ------------------------------------------------------------ shopping ----

export {
  addShoppingItem,
  addStore,
  clearBoughtItems,
  createList,
  deferList,
  deleteList,
  deleteShoppingItem,
  deleteTemplate,
  getShoppingItem,
  listShoppingItems,
  listTemplates,
  moveShoppingItem,
  openItemCount,
  openStoreCount,
  removeStore,
  renameList,
  reorderLists,
  reorderStores,
  saveListAsTemplate,
  setShoppingChecked,
  shoppingBoard,
  shoppingRevision,
  storeItemsToBuy,
  updateShoppingItem,
  ShoppingNotFoundError,
  type ShoppingBoard,
  type ShoppingItem,
  type ShoppingItemRow,
  type ShoppingList,
  type ShoppingSection,
  type ShoppingTemplate,
  type ShoppingTemplateStore,
} from "./shopping";
export { DEFAULT_STORES, itemKey } from "./shopping-core";

// ------------------------------------------------------------- returns ----

export type PurchaseReturn = {
  id: string;
  itemName: string;
  store: string;
  returnDeadline: string | null;
  status: ReturnStatus;
  notes: string | null;
  orderRef: string | null;
};

export async function listReturns(opts: { includeReturned?: boolean } = {}): Promise<PurchaseReturn[]> {
  return db()
    .select({
      id: familyPurchaseReturns.id,
      itemName: familyPurchaseReturns.itemName,
      store: familyPurchaseReturns.store,
      returnDeadline: familyPurchaseReturns.returnDeadline,
      status: familyPurchaseReturns.status,
      notes: familyPurchaseReturns.notes,
      orderRef: familyPurchaseReturns.orderRef,
    })
    .from(familyPurchaseReturns)
    .where(opts.includeReturned ? undefined : ne(familyPurchaseReturns.status, "returned"))
    .orderBy(sql`${familyPurchaseReturns.returnDeadline} asc nulls last`, asc(familyPurchaseReturns.createdAt));
}

export async function addReturn(input: {
  itemName: string;
  store: string;
  returnDeadline?: string | null;
  notes?: string | null;
  orderRef?: string | null;
}) {
  assertNoCardNumber(input.itemName, input.notes, input.orderRef);
  const [row] = await db()
    .insert(familyPurchaseReturns)
    .values({
      itemName: input.itemName.trim().slice(0, 80),
      store: input.store.trim().slice(0, 40),
      returnDeadline: input.returnDeadline || null,
      notes: input.notes?.trim().slice(0, 300) || null,
      orderRef: input.orderRef?.trim().slice(0, 60) || null,
    })
    .returning({ id: familyPurchaseReturns.id });
  return row.id;
}

export async function setReturnStatus(id: string, status: ReturnStatus, now = new Date()) {
  await db()
    .update(familyPurchaseReturns)
    .set({ status, updatedAt: now, returnedAt: status === "returned" ? now : null })
    .where(eq(familyPurchaseReturns.id, id));
}

export async function deleteReturn(id: string) {
  await db().delete(familyPurchaseReturns).where(eq(familyPurchaseReturns.id, id));
}

/** Next status when a return card is tapped: pending → packed in car → returned. */
export function nextReturnStatus(s: ReturnStatus): ReturnStatus {
  return s === "pending" ? "packed_in_car" : "returned";
}

// ------------------------------------------- single items (assistant) ----

export async function getReturn(id: string): Promise<PurchaseReturn | null> {
  const [row] = await db()
    .select({
      id: familyPurchaseReturns.id,
      itemName: familyPurchaseReturns.itemName,
      store: familyPurchaseReturns.store,
      returnDeadline: familyPurchaseReturns.returnDeadline,
      status: familyPurchaseReturns.status,
      notes: familyPurchaseReturns.notes,
      orderRef: familyPurchaseReturns.orderRef,
    })
    .from(familyPurchaseReturns)
    .where(eq(familyPurchaseReturns.id, id));
  return row ?? null;
}

export async function updateReturn(
  id: string,
  patch: { itemName?: string; store?: string; returnDeadline?: string | null; notes?: string | null; status?: ReturnStatus },
  now = new Date(),
) {
  assertNoCardNumber(patch.itemName, patch.notes);
  if (patch.status !== undefined) await setReturnStatus(id, patch.status, now);
  await db()
    .update(familyPurchaseReturns)
    .set({
      ...(patch.itemName !== undefined && { itemName: patch.itemName.trim().slice(0, 80) }),
      ...(patch.store !== undefined && { store: patch.store.trim().slice(0, 40) }),
      ...(patch.returnDeadline !== undefined && { returnDeadline: patch.returnDeadline || null }),
      ...(patch.notes !== undefined && { notes: patch.notes?.trim().slice(0, 300) || null }),
      updatedAt: now,
    })
    .where(eq(familyPurchaseReturns.id, id));
}

export type ChoreSnapshot = {
  id: string;
  kidId: string;
  kidName: string;
  title: string;
  icon: string;
  recurrence: Recurrence;
  stars: number;
  archived: boolean;
  /** Done for its current period (today, this week, or ever for one-off chores). */
  done: boolean;
};

export async function getChore(id: string, now = new Date()): Promise<ChoreSnapshot | null> {
  const [row] = await db()
    .select({ chore: familyChores, kidName: familyKids.name })
    .from(familyChores)
    .innerJoin(familyKids, eq(familyChores.kidId, familyKids.id))
    .where(eq(familyChores.id, id));
  if (!row) return null;
  const c = row.chore;
  const bucket = c.recurrence === "once" ? null : bucketFor(c.recurrence, now, tz());
  const [done] = await db()
    .select({ id: familyChoreCompletions.id })
    .from(familyChoreCompletions)
    .where(and(eq(familyChoreCompletions.choreId, id), bucket ? eq(familyChoreCompletions.dateBucket, bucket) : undefined))
    .limit(1);
  return {
    id: c.id,
    kidId: c.kidId,
    kidName: row.kidName,
    title: c.title,
    icon: c.icon,
    recurrence: c.recurrence,
    stars: c.stars,
    archived: c.archivedAt != null,
    done: Boolean(done),
  };
}

/** Puts an archived chore back on the board. */
export async function unarchiveChore(id: string) {
  await db().update(familyChores).set({ archivedAt: null }).where(eq(familyChores.id, id));
}

// -------------------------------------------------------- housekeeping ----

/**
 * Hourly tidy-up (cron): ticked shopping items disappear 12 hours after
 * they were ticked; returned items are deleted after 30 days. Chores
 * need nothing: they reset by period (see time.ts).
 */
export async function runHousekeeping(now = new Date()) {
  const shoppingCleared = await clearBoughtItems(now);
  const returns = await db()
    .delete(familyPurchaseReturns)
    .where(and(eq(familyPurchaseReturns.status, "returned"), lt(familyPurchaseReturns.returnedAt, new Date(now.getTime() - 30 * 86_400_000))))
    .returning({ id: familyPurchaseReturns.id });
  await pruneOldSuggestions(now);
  return { shoppingCleared, returnsCleared: returns.length };
}

/** Today's date in household time (for deadlines and labels). */
export function today(now = new Date()): string {
  return householdToday(now, tz());
}

// --------------------------------------------------------- return emails ----

export {
  disconnectMailbox,
  finishMailConnect,
  getOwnSuggestion,
  listMailboxes,
  listReturnSuggestions,
  mailRedirectUri,
  markSuggestion,
  MailConnectError,
  scanDueMailboxes,
  scanMemberMailboxes,
  setMailboxSpam,
  startMailConnect,
  type MailboxView,
  type Member,
  type ReturnSuggestion,
  type ScanResult,
} from "./mail";
export { extractReturn, type ExtractedReturn } from "./return-extract";

/** "User 1" / "User 2" (the sign-in's owner label) to the member key used by return emails. */
export function memberFromLabel(label: "User 1" | "User 2"): "user1" | "user2" {
  return label === "User 1" ? "user1" : "user2";
}
