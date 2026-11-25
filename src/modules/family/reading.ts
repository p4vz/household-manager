import { addDays } from "@/core/time/zoned";

/**
 * Reading log rules (Pavel, 2026-11-25). Pure, so it is unit tested.
 *
 * - A day counts when the kid read at least 20 minutes in English or 15 in
 *   Russian. Mixed days count when the parts add up (10 min English plus
 *   8 min Russian is 0.5 + 0.53 of a day, so it counts).
 * - Milestones add stars to the star bank: every 5 counted days in a row,
 *   and every 30 counted days in all. Taking an entry back takes its
 *   milestone back too, because stars are worked out from the log.
 */
export const READING_LANGUAGES = ["en", "ru"] as const;
export type ReadingLanguage = (typeof READING_LANGUAGES)[number];
export const MINUTES_TO_COUNT: Record<ReadingLanguage, number> = { en: 20, ru: 15 };
export const LANGUAGE_LABEL: Record<ReadingLanguage, string> = { en: "English", ru: "Russian" };

export const STREAK_MILESTONE = { days: 5, stars: 10 };
export const TOTAL_MILESTONE = { days: 30, stars: 50 };

export type ReadingEntry = { day: string; language: ReadingLanguage; minutes: number };

/** Share of the day's goal reached, 1 = counts. */
export function dayShare(entries: ReadingEntry[]): number {
  return entries.reduce((s, e) => s + e.minutes / MINUTES_TO_COUNT[e.language], 0);
}

export type ReadingStats = {
  /** The day these stats are for (today). */
  day: string;
  /** Counted days, oldest first. */
  countedDays: string[];
  totalDays: number;
  /** Counted days in a row up to today (today counts once it is reached). */
  streak: number;
  bestStreak: number;
  /** Today's progress toward counting, 0..1. */
  todayShare: number;
  stars: number;
  /** Milestones reached, oldest first: "5 days in a row", "30 days of reading". */
  milestones: { day: string; label: string; stars: number }[];
  nextStreakAt: number;
  nextTotalAt: number;
};

export function readingStats(entries: ReadingEntry[], today: string): ReadingStats {
  const byDay = new Map<string, ReadingEntry[]>();
  for (const e of entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  const countedDays = [...byDay.entries()]
    .filter(([, es]) => dayShare(es) >= 1 - 1e-9)
    .map(([d]) => d)
    .sort();

  const milestones: ReadingStats["milestones"] = [];
  let run = 0;
  let best = 0;
  let prev: string | null = null;
  countedDays.forEach((d, i) => {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
    if (run % STREAK_MILESTONE.days === 0) milestones.push({ day: d, label: `${run} days in a row`, stars: STREAK_MILESTONE.stars });
    if ((i + 1) % TOTAL_MILESTONE.days === 0) milestones.push({ day: d, label: `${i + 1} days of reading`, stars: TOTAL_MILESTONE.stars });
  });

  const counted = new Set(countedDays);
  let streak = 0;
  for (let d = counted.has(today) ? today : addDays(today, -1); counted.has(d); d = addDays(d, -1)) streak += 1;

  return {
    day: today,
    countedDays,
    totalDays: countedDays.length,
    streak,
    bestStreak: best,
    todayShare: Math.min(1, dayShare(byDay.get(today) ?? [])),
    stars: milestones.reduce((s, m) => s + m.stars, 0),
    milestones,
    nextStreakAt: (Math.floor(streak / STREAK_MILESTONE.days) + 1) * STREAK_MILESTONE.days,
    nextTotalAt: (Math.floor(countedDays.length / TOTAL_MILESTONE.days) + 1) * TOTAL_MILESTONE.days,
  };
}
