import { addDays } from "@/core/time/zoned";
import type { Recurrence } from "./time";

/**
 * Chore stats for one kid, computed from stored completions. Pure.
 *
 * - today: done / shown on the board right now
 * - week: completion rate for the chore week so far (daily chores count
 *   once per day they existed, weekly chores once, one-time chores once)
 * - streak: consecutive chore days on which every daily chore was done,
 *   counting today only once it is complete
 * - stars: earned this week and in total
 */
export type StatChore = {
  id: string;
  recurrence: Recurrence;
  /** Chore day the chore was created / archived (see time.ts dayBucket). */
  createdDay: string;
  archivedDay: string | null;
};

export type StatCompletion = { choreId: string; dateBucket: string; stars: number };

export type KidStats = {
  todayDone: number;
  todayTotal: number;
  weekPercent: number;
  /** Chores done / due so far this chore week (same counting as weekPercent). */
  weekDone: number;
  weekTotal: number;
  streak: number;
  starsWeek: number;
  starsTotal: number;
};

const existedOn = (c: StatChore, day: string) => c.createdDay <= day && (c.archivedDay === null || c.archivedDay > day);

export function computeKidStats(input: {
  chores: StatChore[];
  completions: StatCompletion[];
  today: string;
  weekStart: string;
  starsTotal: number;
  /** Board counts (what is on screen now). */
  todayDone: number;
  todayTotal: number;
}): KidStats {
  const { chores, completions, today, weekStart } = input;
  const done = new Set(completions.map((c) => `${c.choreId}|${c.dateBucket}`));

  let expected = 0;
  let achieved = 0;
  for (let day = weekStart; day <= today; day = addDays(day, 1)) {
    for (const c of chores) {
      if (c.recurrence !== "daily" || !existedOn(c, day)) continue;
      expected += 1;
      if (done.has(`${c.id}|${day}`)) achieved += 1;
    }
  }
  for (const c of chores) {
    if (c.recurrence === "weekly" && existedOn(c, today)) {
      expected += 1;
      if (done.has(`${c.id}|${weekStart}`)) achieved += 1;
    }
    if (c.recurrence === "once" && c.createdDay >= weekStart) {
      expected += 1;
      if (completions.some((x) => x.choreId === c.id)) achieved += 1;
    }
  }

  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const day = addDays(today, -i);
    const daily = chores.filter((c) => c.recurrence === "daily" && existedOn(c, day));
    if (daily.length === 0) break;
    const complete = daily.every((c) => done.has(`${c.id}|${day}`));
    if (!complete) {
      if (i === 0) continue; // today is still in progress
      break;
    }
    streak += 1;
  }

  const starsWeek = completions.filter((c) => c.dateBucket >= weekStart).reduce((s, c) => s + c.stars, 0);

  return {
    todayDone: input.todayDone,
    todayTotal: input.todayTotal,
    weekPercent: expected ? Math.round((achieved / expected) * 100) : 0,
    weekDone: achieved,
    weekTotal: expected,
    streak,
    starsWeek,
    starsTotal: input.starsTotal,
  };
}
