import "server-only";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/core/db/client";
import { householdTimeZone } from "@/core/time/zoned";
import { familyChoreCompletions, familyChores } from "./schema";
import { addDays, dayBucket } from "./time";

/**
 * The chore log: each kid's done chores, newest first. Kids can look at it
 * on the kitchen screen; adding a missed one or taking a wrong one off is
 * for adults (adult mode on the screen, or a signed-in parent), since every
 * entry carries stars.
 */
const tz = () => householdTimeZone();

export class ChoreLogError extends Error {}

/** How far back the log shows, and how far back a parent can add a missed chore. */
export const CHORE_LOG_DAYS = 60;

export type ChoreLogEntry = {
  id: string;
  /** The chore day, or for weekly chores the Monday of that week. */
  day: string;
  choreId: string;
  title: string;
  icon: string;
  recurrence: "daily" | "weekly" | "once";
  stars: number;
};

/** The log for one kid, plus today's chore day (for the add form). */
export async function choreLog(kidId: string, now = new Date()): Promise<{ today: string; entries: ChoreLogEntry[] }> {
  const today = dayBucket(now, tz());
  const from = addDays(today, -CHORE_LOG_DAYS);
  const entries = await db()
    .select({
      id: familyChoreCompletions.id,
      day: familyChoreCompletions.dateBucket,
      choreId: familyChoreCompletions.choreId,
      title: familyChores.title,
      icon: familyChores.icon,
      recurrence: familyChores.recurrence,
      stars: familyChoreCompletions.stars,
    })
    .from(familyChoreCompletions)
    .innerJoin(familyChores, eq(familyChores.id, familyChoreCompletions.choreId))
    .where(and(eq(familyChoreCompletions.kidId, kidId), gte(familyChoreCompletions.dateBucket, from)))
    .orderBy(desc(familyChoreCompletions.dateBucket), desc(familyChoreCompletions.completedAt))
    .limit(500);
  return { today, entries };
}

/** The bucket a chore done on `day` belongs to: the day, or the Monday of its week. */
function bucketOfDay(recurrence: string, day: string): string {
  if (recurrence !== "weekly") return day;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

/** Adds a chore a kid did but didn't tick. Returns false if it was already in the log for that day (or week). */
export async function addChoreDone(input: { choreId: string; day: string }, now = new Date()): Promise<boolean> {
  const today = dayBucket(now, tz());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day) || Number.isNaN(Date.parse(`${input.day}T00:00:00Z`))) throw new ChoreLogError("Pick a day.");
  if (input.day > today) throw new ChoreLogError("That day hasn't happened yet.");
  if (input.day < addDays(today, -CHORE_LOG_DAYS)) throw new ChoreLogError(`Only the last ${CHORE_LOG_DAYS} days can be added.`);
  const [chore] = await db().select().from(familyChores).where(and(eq(familyChores.id, input.choreId), isNull(familyChores.archivedAt)));
  if (!chore) throw new ChoreLogError("That chore is gone.");
  const rows = await db()
    .insert(familyChoreCompletions)
    .values({
      kidId: chore.kidId,
      choreId: chore.id,
      // Noon UTC on that day: a stable time inside the chore day.
      completedAt: new Date(`${input.day}T12:00:00Z`),
      dateBucket: bucketOfDay(chore.recurrence, input.day),
      stars: chore.stars,
    })
    .onConflictDoNothing()
    .returning({ id: familyChoreCompletions.id });
  return rows.length > 0;
}

/** Takes an entry off the log (and its stars with it). */
export async function removeChoreDone(id: string): Promise<void> {
  await db().delete(familyChoreCompletions).where(eq(familyChoreCompletions.id, id));
}
