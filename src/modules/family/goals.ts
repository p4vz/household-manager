import { addDays } from "@/core/time/zoned";
import type { Recurrence } from "./time";

/**
 * Chore goals, streaks and badges for the kids. Pure, so it is unit tested.
 *
 * A goal follows one chore: "read 10 days in a row" (a streak goal) or
 * "read 30 times" (a count goal), with a reward a parent wrote ("pick a
 * prize", "Roblox access"). A streak counts consecutive chore days (or
 * weeks, for a weekly chore) since the goal started; today counts once it is
 * done, and a day not done yet today doesn't break it. Missing a day starts
 * the streak over. A goal is reached once, and stays reached.
 */
export type GoalKind = "streak" | "count";

/** Chore periods ending at `current`, newest first, never before `from`. */
function periods(recurrence: Recurrence, current: string, from: string): string[] {
  const step = recurrence === "weekly" ? 7 : 1;
  const out: string[] = [];
  for (let p = current; p >= from && out.length < 1000; p = addDays(p, -step)) out.push(p);
  return out;
}

/**
 * Current and best streak of one chore since `from`.
 * `current` is today's bucket (daily) or this week's Monday (weekly).
 */
export function choreStreak(done: ReadonlySet<string>, recurrence: Recurrence, current: string, from: string): { current: number; best: number } {
  if (recurrence === "once") return { current: 0, best: 0 };
  const list = periods(recurrence, current, from);
  let cur = 0;
  for (let i = 0; i < list.length; i++) {
    if (done.has(list[i])) cur += 1;
    else if (i === 0) continue; // this period is still open
    else break;
  }
  let best = 0;
  let run = 0;
  for (const p of [...list].reverse()) {
    run = done.has(p) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { current: cur, best: Math.max(best, cur) };
}

export type GoalInput = {
  id: string;
  kind: GoalKind;
  target: number;
  recurrence: Recurrence;
  startedOn: string;
  achievedOn: string | null;
};

export type GoalProgress = { progress: number; reached: boolean; best: number };

/** `done`: the chore's completed buckets. `current`: today's bucket for that chore. */
export function goalProgress(goal: GoalInput, done: ReadonlySet<string>, current: string): GoalProgress {
  const since = [...done].filter((b) => b >= goal.startedOn && b <= current);
  if (goal.kind === "count") {
    const progress = since.length;
    return { progress: Math.min(progress, goal.target), reached: goal.achievedOn !== null || progress >= goal.target, best: progress };
  }
  // A weekly chore's first period is the week the goal started in.
  const from = goal.recurrence === "weekly" ? weekOf(goal.startedOn) : goal.startedOn;
  const s = choreStreak(new Set(since), goal.recurrence, current, from);
  return { progress: Math.min(s.current, goal.target), reached: goal.achievedOn !== null || s.current >= goal.target || s.best >= goal.target, best: s.best };
}

function weekOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

export type Badge = { key: string; emoji: string; label: string };

const STREAK_BADGES: [number, string, string][] = [
  [3, "✨", "3 days in a row"],
  [7, "🔥", "A whole week"],
  [14, "🚀", "Two weeks strong"],
  [30, "🏆", "30-day legend"],
  [60, "💎", "60-day diamond"],
  [100, "👑", "100 days!"],
];

const STAR_BADGES: [number, string, string][] = [
  [25, "⭐", "25 stars"],
  [100, "🌟", "100 stars"],
  [250, "💫", "250 stars"],
  [500, "🌠", "500 stars"],
  [1000, "🌌", "1,000 stars"],
];

/** Badges a kid has earned: from their best streak on any daily chore, total stars and goals reached. */
export function kidBadges(input: { bestStreak: number; starsTotal: number; goalsReached: number }): Badge[] {
  const out: Badge[] = [];
  for (const [n, emoji, label] of STREAK_BADGES) if (input.bestStreak >= n) out.push({ key: `streak-${n}`, emoji, label });
  for (const [n, emoji, label] of STAR_BADGES) if (input.starsTotal >= n) out.push({ key: `stars-${n}`, emoji, label });
  if (input.goalsReached > 0) out.push({ key: "goals", emoji: "🎯", label: input.goalsReached === 1 ? "Reached a goal" : `Reached ${input.goalsReached} goals` });
  return out;
}

/** The next streak badge to aim for, for a "3 more days to 🔥" hint. */
export function nextStreakBadge(bestStreak: number): { emoji: string; label: string; days: number } | null {
  const next = STREAK_BADGES.find(([n]) => n > bestStreak);
  return next ? { emoji: next[1], label: next[2], days: next[0] } : null;
}

/** One row per day for a chore's history grid: done or not, newest last. Weekly chores mark the whole week. */
export function historyGrid(done: ReadonlySet<string>, recurrence: Recurrence, today: string, days: number, createdDay: string): ("done" | "missed" | "none")[] {
  const out: ("done" | "missed" | "none")[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    if (day < createdDay) {
      out.push("none");
      continue;
    }
    const bucket = recurrence === "weekly" ? weekOf(day) : day;
    if (done.has(bucket)) out.push("done");
    else out.push(i === 0 || (recurrence === "weekly" && bucket === weekOf(today)) ? "none" : "missed");
  }
  return out;
}
