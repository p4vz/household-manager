import { describe, expect, it } from "vitest";
import { choreStreak, goalProgress, historyGrid, kidBadges, nextStreakBadge } from "@/modules/family/goals";

const days = (...d: string[]) => new Set(d);

describe("chore streaks", () => {
  it("counts consecutive days, and today only once it is done", () => {
    const done = days("2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24");
    expect(choreStreak(done, "daily", "2026-11-25", "2026-11-01")).toEqual({ current: 4, best: 4 });
    done.add("2026-11-25");
    expect(choreStreak(done, "daily", "2026-11-25", "2026-11-01").current).toBe(5);
  });

  it("starts over after a missed day and remembers the best run", () => {
    const done = days("2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-15", "2026-11-16");
    expect(choreStreak(done, "daily", "2026-11-17", "2026-11-01")).toEqual({ current: 2, best: 4 });
    expect(choreStreak(done, "daily", "2026-11-19", "2026-11-01").current).toBe(0);
  });

  it("counts weeks for weekly chores", () => {
    const done = days("2026-11-09", "2026-11-16");
    expect(choreStreak(done, "weekly", "2026-11-23", "2026-11-01").current).toBe(2);
  });
});

describe("chore goals", () => {
  const read10 = { id: "g", kind: "streak" as const, target: 10, recurrence: "daily" as const, startedOn: "2026-11-10", achievedOn: null };

  it("tracks a 10-day reading streak from the day the goal started", () => {
    const done = days("2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12");
    // Days before the goal don't count.
    expect(goalProgress(read10, done, "2026-11-13")).toMatchObject({ progress: 3, reached: false });
  });

  it("is reached after 10 days in a row, and stays reached after a missed day", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `2026-11-${String(10 + i).padStart(2, "0")}`);
    expect(goalProgress(read10, days(...ten), "2026-11-19")).toMatchObject({ progress: 10, reached: true });
    // Two days later, missed: the best run still reached it.
    expect(goalProgress(read10, days(...ten), "2026-11-22").reached).toBe(true);
    expect(goalProgress({ ...read10, achievedOn: "2026-11-19" }, days(), "2026-11-25").reached).toBe(true);
  });

  it("starts the streak over when a day is missed before the target", () => {
    const done = days("2026-11-10", "2026-11-11", "2026-11-12", "2026-11-14");
    expect(goalProgress(read10, done, "2026-11-15")).toMatchObject({ progress: 1, reached: false });
  });

  it("count goals add up every time since the start", () => {
    const g = { ...read10, kind: "count" as const, target: 3 };
    expect(goalProgress(g, days("2026-11-09", "2026-11-11", "2026-11-14"), "2026-11-15")).toMatchObject({ progress: 2, reached: false });
    expect(goalProgress(g, days("2026-11-11", "2026-11-14", "2026-11-15"), "2026-11-15")).toMatchObject({ progress: 3, reached: true });
  });
});

describe("badges and history", () => {
  it("gives streak, star and goal badges", () => {
    expect(kidBadges({ bestStreak: 8, starsTotal: 120, goalsReached: 1 }).map((b) => b.emoji)).toEqual(["✨", "🔥", "⭐", "🌟", "🎯"]);
    expect(nextStreakBadge(8)).toMatchObject({ emoji: "🚀", days: 14 });
    expect(nextStreakBadge(500)).toBeNull();
  });

  it("marks done and missed days, leaving today and days before the chore blank", () => {
    expect(historyGrid(days("2026-11-23"), "daily", "2026-11-25", 4, "2026-11-23")).toEqual(["none", "done", "missed", "none"]);
  });
});
