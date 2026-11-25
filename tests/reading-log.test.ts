import { describe, expect, it } from "vitest";
import { dayShare, readingStats } from "@/modules/family/reading";

const en = (day: string, minutes: number) => ({ day, language: "en" as const, minutes });
const ru = (day: string, minutes: number) => ({ day, language: "ru" as const, minutes });
const days = (from: number, n: number, lang = en, minutes = 20) => Array.from({ length: n }, (_, i) => lang(`2026-11-${String(from + i).padStart(2, "0")}`, minutes));

describe("reading log rules", () => {
  it("counts a day at 20 minutes of English or 15 of Russian, or a mix that adds up", () => {
    expect(dayShare([en("d", 19)])).toBeLessThan(1);
    expect(dayShare([en("d", 20)])).toBe(1);
    expect(dayShare([ru("d", 15)])).toBe(1);
    expect(dayShare([en("d", 10), ru("d", 8)])).toBeGreaterThanOrEqual(1);
    expect(dayShare([en("d", 10), en("d", 10)])).toBe(1);
  });

  it("gives 10 stars for every 5 days in a row", () => {
    const s = readingStats(days(1, 5), "2026-11-05");
    expect(s).toMatchObject({ totalDays: 5, streak: 5, stars: 10, nextStreakAt: 10 });
    expect(s.milestones.map((m) => m.label)).toEqual(["5 days in a row"]);
    // A short day breaks the run.
    const broken = readingStats([...days(1, 3), en("2026-11-04", 10), ...days(5, 3)], "2026-11-07");
    expect(broken).toMatchObject({ totalDays: 6, streak: 3, stars: 0 });
  });

  it("gives 50 stars at 30 reading days, in a row or not", () => {
    const spread = Array.from({ length: 30 }, (_, i) => ru(new Date(Date.UTC(2026, 8, 1 + i * 2)).toISOString().slice(0, 10), 15));
    const s = readingStats(spread, "2026-11-25");
    expect(s).toMatchObject({ totalDays: 30, streak: 0, stars: 50, nextTotalAt: 60 });
  });

  it("keeps the streak alive until today is read, and tracks today's share", () => {
    const s = readingStats([...days(20, 4), en("2026-11-24", 10)], "2026-11-24");
    expect(s.streak).toBe(4);
    expect(s.todayShare).toBe(0.5);
    expect(readingStats(days(20, 3), "2026-11-25").streak).toBe(0);
  });
});
