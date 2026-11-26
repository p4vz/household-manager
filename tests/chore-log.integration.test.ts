import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";

/** The chore log: look back, add a missed chore for an earlier day, take a wrong one off. */
let api: typeof import("@/modules/family/api");
const now = new Date("2026-11-26T17:00:00Z"); // Thursday, household time New York

beforeAll(async () => {
  await freshDb();
  api = await import("@/modules/family/api");
});

describe("chore log", () => {
  it("lists done chores newest first, and lets a parent add and remove entries", async () => {
    const kid = await api.addKid({ name: "Leo" });
    const kidId = typeof kid === "string" ? kid : (kid as { id: string }).id;
    const daily = await api.addChore({ kidId, title: "Make bed", recurrence: "daily", stars: 1 }, now);
    const weekly = await api.addChore({ kidId, title: "Tidy room", recurrence: "weekly", stars: 3 }, now);
    const dailyId = typeof daily === "string" ? daily : (daily as { id: string }).id;
    const weeklyId = typeof weekly === "string" ? weekly : (weekly as { id: string }).id;

    await api.completeChore(dailyId, now);
    expect(await api.addChoreDone({ choreId: dailyId, day: "2026-11-24" }, now)).toBe(true);
    // Same chore, same day: not doubled.
    expect(await api.addChoreDone({ choreId: dailyId, day: "2026-11-24" }, now)).toBe(false);
    // A weekly chore lands on the Monday of its week.
    expect(await api.addChoreDone({ choreId: weeklyId, day: "2026-11-20" }, now)).toBe(true);

    const log = await api.choreLog(kidId, now);
    expect(log.today).toBe("2026-11-26");
    expect(log.entries.map((e) => [e.day, e.title, e.stars])).toEqual([
      ["2026-11-26", "Make bed", 1],
      ["2026-11-24", "Make bed", 1],
      ["2026-11-16", "Tidy room", 3],
    ]);

    await expect(api.addChoreDone({ choreId: dailyId, day: "2026-11-27" }, now)).rejects.toThrow(/hasn't happened/);
    await expect(api.addChoreDone({ choreId: dailyId, day: "2026-08-01" }, now)).rejects.toThrow(/last 60 days/);

    await api.removeChoreDone(log.entries[1].id);
    expect((await api.choreLog(kidId, now)).entries).toHaveLength(2);
  });
});
