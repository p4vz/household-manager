import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { householdTimeZone } from "@/core/time/zoned";
import { assertNoCardNumber } from "./guard";
import { choreStreak, goalProgress, historyGrid, kidBadges, nextStreakBadge, type Badge, type GoalKind } from "./goals";
import { familyChoreCompletions, familyChoreGoals, familyChores, familyKids } from "./schema";
import { addDays, dayBucket, weekBucket, type Recurrence } from "./time";

/**
 * Chore goals and progress for the kids (goals.ts has the rules). Parents
 * set goals and mark rewards given from the phone (member-only actions); the
 * kitchen screen only shows progress.
 */
const tz = () => householdTimeZone();
export const GOAL_KINDS = ["streak", "count"] as const satisfies readonly GoalKind[];
export const MAX_GOAL_TARGET = 365;

export class GoalError extends Error {}

export type GoalView = {
  id: string;
  kidId: string;
  choreId: string;
  choreTitle: string;
  choreIcon: string;
  recurrence: Recurrence;
  kind: GoalKind;
  target: number;
  progress: number;
  reached: boolean;
  achievedOn: string | null;
  rewardGivenAt: string | null;
  reward: string;
  rewardEmoji: string;
  startedOn: string;
  /** "days" for a daily streak, "weeks" for a weekly one, "times" for a count. */
  unit: "days" | "weeks" | "times";
};

export type KidProgress = {
  kidId: string;
  /** Goals not archived and not yet handed out, plus reached ones waiting for their reward. */
  goals: GoalView[];
  badges: Badge[];
  bestStreak: number;
  nextBadge: { emoji: string; label: string; days: number } | null;
};

type ChoreRow = typeof familyChores.$inferSelect;

async function completionsByChore(choreIds: string[], from: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (choreIds.length === 0) return out;
  const rows = await db()
    .select({ choreId: familyChoreCompletions.choreId, bucket: familyChoreCompletions.dateBucket })
    .from(familyChoreCompletions)
    .where(and(inArray(familyChoreCompletions.choreId, choreIds), sql`${familyChoreCompletions.dateBucket} >= ${from}`));
  for (const r of rows) {
    const set = out.get(r.choreId) ?? new Set<string>();
    set.add(r.bucket);
    out.set(r.choreId, set);
  }
  return out;
}

const currentBucket = (recurrence: Recurrence, now: Date) => (recurrence === "weekly" ? weekBucket(now, tz()) : dayBucket(now, tz()));

function toView(g: typeof familyChoreGoals.$inferSelect, chore: ChoreRow, done: Set<string>, now: Date): GoalView {
  const p = goalProgress(
    { id: g.id, kind: g.kind, target: g.target, recurrence: chore.recurrence, startedOn: g.startedOn, achievedOn: g.achievedOn },
    done,
    currentBucket(chore.recurrence, now),
  );
  return {
    id: g.id,
    kidId: g.kidId,
    choreId: g.choreId,
    choreTitle: chore.title,
    choreIcon: chore.icon,
    recurrence: chore.recurrence,
    kind: g.kind,
    target: g.target,
    progress: p.reached ? g.target : p.progress,
    reached: p.reached,
    achievedOn: g.achievedOn,
    rewardGivenAt: g.rewardGivenAt?.toISOString() ?? null,
    reward: g.reward,
    rewardEmoji: g.rewardEmoji,
    startedOn: g.startedOn,
    unit: g.kind === "count" ? "times" : chore.recurrence === "weekly" ? "weeks" : "days",
  };
}

/**
 * Goals with progress. Records `achievedOn` the first time a goal is
 * reached, so a later missed day doesn't take a reached goal away.
 * `includeDone`: also goals whose reward was given (the parents' history).
 */
export async function listGoals(now = new Date(), opts: { includeDone?: boolean } = {}): Promise<GoalView[]> {
  const rows = await db()
    .select({ goal: familyChoreGoals, chore: familyChores })
    .from(familyChoreGoals)
    .innerJoin(familyChores, eq(familyChores.id, familyChoreGoals.choreId))
    .innerJoin(familyKids, eq(familyKids.id, familyChoreGoals.kidId))
    .where(and(isNull(familyChoreGoals.archivedAt), eq(familyKids.active, true), opts.includeDone ? undefined : isNull(familyChoreGoals.rewardGivenAt)))
    .orderBy(asc(familyChoreGoals.createdAt));
  if (rows.length === 0) return [];
  const from = rows.reduce((m, r) => (r.goal.startedOn < m ? r.goal.startedOn : m), rows[0].goal.startedOn);
  const done = await completionsByChore([...new Set(rows.map((r) => r.chore.id))], addDays(from, -7));
  const today = dayBucket(now, tz());
  const views: GoalView[] = [];
  for (const r of rows) {
    const view = toView(r.goal, r.chore, done.get(r.chore.id) ?? new Set(), now);
    if (view.reached && !r.goal.achievedOn) {
      await db().update(familyChoreGoals).set({ achievedOn: today }).where(and(eq(familyChoreGoals.id, r.goal.id), isNull(familyChoreGoals.achievedOn)));
      view.achievedOn = today;
    }
    views.push(view);
  }
  return views;
}

/** Per kid: open goals, badges and best streak, for the chore board. */
export async function kidProgress(now = new Date()): Promise<KidProgress[]> {
  const kids = await db().select({ id: familyKids.id }).from(familyKids).where(eq(familyKids.active, true));
  if (kids.length === 0) return [];
  const [goals, reachedCounts, stars, daily] = await Promise.all([
    listGoals(now),
    db()
      .select({ kidId: familyChoreGoals.kidId, n: sql<number>`count(*)::int` })
      .from(familyChoreGoals)
      .where(sql`${familyChoreGoals.achievedOn} is not null`)
      .groupBy(familyChoreGoals.kidId),
    db()
      .select({ kidId: familyChoreCompletions.kidId, stars: sql<number>`coalesce(sum(${familyChoreCompletions.stars}), 0)::int` })
      .from(familyChoreCompletions)
      .groupBy(familyChoreCompletions.kidId),
    db().select().from(familyChores).where(eq(familyChores.recurrence, "daily")),
  ]);
  const today = dayBucket(now, tz());
  const done = await completionsByChore(
    daily.map((c) => c.id),
    addDays(today, -400),
  );
  return kids.map((k) => {
    const bestStreak = daily
      .filter((c) => c.kidId === k.id)
      .reduce((m, c) => Math.max(m, choreStreak(done.get(c.id) ?? new Set(), "daily", today, addDays(today, -400)).best), 0);
    return {
      kidId: k.id,
      goals: goals.filter((g) => g.kidId === k.id),
      badges: kidBadges({
        bestStreak,
        starsTotal: stars.find((s) => s.kidId === k.id)?.stars ?? 0,
        goalsReached: reachedCounts.find((r) => r.kidId === k.id)?.n ?? 0,
      }),
      bestStreak,
      nextBadge: nextStreakBadge(bestStreak),
    };
  });
}

export async function createGoal(
  input: { kidId: string; choreId: string; kind: GoalKind; target: number; reward: string; rewardEmoji?: string },
  createdBy: string,
  now = new Date(),
): Promise<string> {
  const [chore] = await db().select().from(familyChores).where(and(eq(familyChores.id, input.choreId), eq(familyChores.kidId, input.kidId), isNull(familyChores.archivedAt)));
  if (!chore) throw new GoalError("Pick one of this kid's chores.");
  if (chore.recurrence === "once") throw new GoalError("Goals work with daily or weekly chores.");
  if (!Number.isInteger(input.target) || input.target < 2 || input.target > MAX_GOAL_TARGET) throw new GoalError(`Pick a target from 2 to ${MAX_GOAL_TARGET}.`);
  const reward = input.reward.trim().slice(0, 80);
  if (!reward) throw new GoalError("Say what the reward is.");
  assertNoCardNumber(reward);
  const [row] = await db()
    .insert(familyChoreGoals)
    .values({
      kidId: input.kidId,
      choreId: input.choreId,
      kind: input.kind,
      target: input.target,
      reward,
      rewardEmoji: (input.rewardEmoji ?? "🎁").slice(0, 8) || "🎁",
      startedOn: dayBucket(now, tz()),
      createdBy,
    })
    .returning({ id: familyChoreGoals.id });
  return row.id;
}

/** A parent handed the reward over: the goal moves to the history. */
export async function markRewardGiven(id: string, now = new Date()): Promise<void> {
  const [g] = await db().select().from(familyChoreGoals).where(eq(familyChoreGoals.id, id));
  if (!g) throw new GoalError("Goal not found.");
  if (!g.achievedOn) throw new GoalError("That goal isn't reached yet.");
  await db().update(familyChoreGoals).set({ rewardGivenAt: now }).where(eq(familyChoreGoals.id, id));
}

/** Same chore, target and reward again, starting today. */
export async function repeatGoal(id: string, createdBy: string, now = new Date()): Promise<string> {
  const [g] = await db().select().from(familyChoreGoals).where(eq(familyChoreGoals.id, id));
  if (!g) throw new GoalError("Goal not found.");
  return createGoal({ kidId: g.kidId, choreId: g.choreId, kind: g.kind, target: g.target, reward: g.reward, rewardEmoji: g.rewardEmoji }, createdBy, now);
}

export async function archiveGoal(id: string, now = new Date()): Promise<void> {
  await db().update(familyChoreGoals).set({ archivedAt: now }).where(eq(familyChoreGoals.id, id));
}

export type ChoreHistory = {
  kidId: string;
  kidName: string;
  color: string;
  emoji: string;
  /** Stars per chore week, oldest first (Monday dates). */
  weeks: { weekStart: string; stars: number }[];
  chores: { id: string; title: string; icon: string; recurrence: Recurrence; grid: ("done" | "missed" | "none")[]; streak: number; best: number; doneCount: number }[];
  goalsDone: GoalView[];
};

/** For parents: each kid's chores over the last `days` days, weekly stars and goals reached. */
export async function choreHistory(now = new Date(), days = 84): Promise<{ days: string[]; kids: ChoreHistory[] }> {
  const zone = tz();
  const today = dayBucket(now, zone);
  const from = addDays(today, -days - 7);
  const kids = await db().select().from(familyKids).where(eq(familyKids.active, true)).orderBy(asc(familyKids.sortOrder), asc(familyKids.createdAt));
  const chores = await db()
    .select()
    .from(familyChores)
    .where(and(isNull(familyChores.archivedAt), inArray(familyChores.recurrence, ["daily", "weekly"])))
    .orderBy(asc(familyChores.sortOrder), asc(familyChores.createdAt));
  const done = await completionsByChore(
    chores.map((c) => c.id),
    from,
  );
  const starRows = await db()
    .select({ kidId: familyChoreCompletions.kidId, bucket: familyChoreCompletions.dateBucket, stars: familyChoreCompletions.stars })
    .from(familyChoreCompletions)
    .where(sql`${familyChoreCompletions.dateBucket} >= ${from}`);
  const goals = (await listGoals(now, { includeDone: true })).filter((g) => g.rewardGivenAt);
  const thisWeek = weekBucket(now, zone);
  const weekStarts = Array.from({ length: 12 }, (_, i) => addDays(thisWeek, -7 * (11 - i)));

  return {
    days: Array.from({ length: days }, (_, i) => addDays(today, -(days - 1 - i))),
    kids: kids.map((k) => ({
      kidId: k.id,
      kidName: k.name,
      color: k.color,
      emoji: k.emoji,
      weeks: weekStarts.map((w) => ({
        weekStart: w,
        stars: starRows.filter((r) => r.kidId === k.id && r.bucket >= w && r.bucket < addDays(w, 7)).reduce((s, r) => s + r.stars, 0),
      })),
      chores: chores
        .filter((c) => c.kidId === k.id)
        .map((c) => {
          const set = done.get(c.id) ?? new Set<string>();
          const s = choreStreak(set, c.recurrence, c.recurrence === "weekly" ? thisWeek : today, from);
          return {
            id: c.id,
            title: c.title,
            icon: c.icon,
            recurrence: c.recurrence,
            grid: historyGrid(set, c.recurrence, today, days, dayBucket(c.createdAt, zone)),
            streak: s.current,
            best: s.best,
            doneCount: [...set].filter((b) => b > addDays(today, -days)).length,
          };
        }),
      goalsDone: goals.filter((g) => g.kidId === k.id).sort((a, b) => (b.rewardGivenAt ?? "").localeCompare(a.rewardGivenAt ?? "")),
    })),
  };
}

