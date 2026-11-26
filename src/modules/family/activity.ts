import "server-only";
import { eq, gt, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { familyChoreCompletions, familyKids, familyPurchaseReturns, familyReadingLog, familyShoppingItems, familyStarSpends } from "./schema";

export type FamilyActivity = {
  kids: { id: string; name: string; emoji: string; chores: number; stars: number; readingMinutes: number }[];
  prizes: { kid: string; emoji: string; prize: string; stars: number }[];
  returnsAdded: number;
  returnsDone: number;
  shoppingAdded: number;
  shoppingBought: number;
};

/**
 * What happened in the family hub after `since`, for the home page's
 * "Since your last visit". Counts and first names only.
 */
export async function familyActivitySince(since: Date): Promise<FamilyActivity> {
  const d = db();
  const [kids, chores, reading, prizes, [returns], [shopping]] = await Promise.all([
    d.select({ id: familyKids.id, name: familyKids.name, emoji: familyKids.emoji }).from(familyKids).where(eq(familyKids.active, true)).orderBy(familyKids.sortOrder),
    d
      .select({ kidId: familyChoreCompletions.kidId, n: sql<number>`count(*)::int`, stars: sql<number>`coalesce(sum(${familyChoreCompletions.stars}), 0)::int` })
      .from(familyChoreCompletions)
      .where(gt(familyChoreCompletions.completedAt, since))
      .groupBy(familyChoreCompletions.kidId),
    d
      .select({ kidId: familyReadingLog.kidId, minutes: sql<number>`coalesce(sum(${familyReadingLog.minutes}), 0)::int` })
      .from(familyReadingLog)
      .where(gt(familyReadingLog.createdAt, since))
      .groupBy(familyReadingLog.kidId),
    d
      .select({ kid: familyKids.name, emoji: familyStarSpends.emoji, prize: familyStarSpends.prizeName, stars: familyStarSpends.stars })
      .from(familyStarSpends)
      .innerJoin(familyKids, eq(familyKids.id, familyStarSpends.kidId))
      .where(gt(familyStarSpends.givenAt, since))
      .orderBy(familyStarSpends.givenAt),
    d
      .select({
        added: sql<number>`count(*) filter (where ${familyPurchaseReturns.createdAt} > ${since.toISOString()}::timestamptz)::int`,
        done: sql<number>`count(*) filter (where ${familyPurchaseReturns.returnedAt} > ${since.toISOString()}::timestamptz)::int`,
      })
      .from(familyPurchaseReturns),
    d
      .select({
        added: sql<number>`count(*) filter (where ${familyShoppingItems.createdAt} > ${since.toISOString()}::timestamptz and not ${familyShoppingItems.checked})::int`,
        bought: sql<number>`count(distinct ${familyShoppingItems.name}) filter (where ${familyShoppingItems.checkedAt} > ${since.toISOString()}::timestamptz)::int`,
      })
      .from(familyShoppingItems),
  ]);
  const choreBy = new Map(chores.map((c) => [c.kidId, c]));
  const readBy = new Map(reading.map((r) => [r.kidId, r.minutes]));
  return {
    kids: kids.map((k) => ({
      ...k,
      chores: choreBy.get(k.id)?.n ?? 0,
      stars: choreBy.get(k.id)?.stars ?? 0,
      readingMinutes: readBy.get(k.id) ?? 0,
    })),
    prizes,
    returnsAdded: returns?.added ?? 0,
    returnsDone: returns?.done ?? 0,
    shoppingAdded: shopping?.added ?? 0,
    shoppingBought: shopping?.bought ?? 0,
  };
}
