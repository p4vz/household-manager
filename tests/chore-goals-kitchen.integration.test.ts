import { beforeAll, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers/db";

/** Claude is never called for real: capture what would be sent. */
const sent: { system: string; task: string; payload: unknown }[] = [];
vi.mock("@/core/ai/run", () => ({
  runStructured: vi.fn(async (opts: { system: string; task: string; payload: unknown }) => {
    sent.push(opts);
    return { answer: "Leo still has to brush teeth." };
  }),
}));

const family = await import("@/modules/family/api");
const { askKitchen, kitchenSnapshot } = await import("@/assistant/kitchen");

// Noon household time on consecutive days.
const at = (day: string) => new Date(`${day}T17:00:00Z`);
let kidId = "";
let readId = "";

beforeAll(async () => {
  process.env.HOUSEHOLD_TIMEZONE = "America/New_York";
  await freshDb();
  kidId = await family.addKid({ name: "Leo" });
  readId = await family.addChore({ kidId, title: "Read 20 min", icon: "📚", recurrence: "daily" }, at("2026-11-01"));
  await family.addChore({ kidId, title: "Brush teeth", icon: "🦷", recurrence: "daily" }, at("2026-11-01"));
});

describe("chore goals", () => {
  it("tracks a reading streak to its reward and keeps it once reached", async () => {
    const goalId = await family.createGoal({ kidId, choreId: readId, kind: "streak", target: 3, reward: "Roblox access", rewardEmoji: "🎮" }, "User 1", at("2026-11-10"));
    await family.completeChore(readId, at("2026-11-10"));
    await family.completeChore(readId, at("2026-11-11"));
    let [g] = await family.listGoals(at("2026-11-11"));
    expect(g).toMatchObject({ id: goalId, progress: 2, reached: false, unit: "days" });
    await expect(family.markRewardGiven(goalId)).rejects.toThrow(/isn't reached/);

    await family.completeChore(readId, at("2026-11-12"));
    [g] = await family.listGoals(at("2026-11-12"));
    expect(g).toMatchObject({ progress: 3, reached: true, achievedOn: "2026-11-12" });
    // Missing days later doesn't take it away.
    [g] = await family.listGoals(at("2026-11-20"));
    expect(g.reached).toBe(true);

    const [p] = await family.kidProgress(at("2026-11-12"));
    expect(p.badges.map((b) => b.emoji)).toEqual(["✨", "🎯"]);

    await family.markRewardGiven(goalId, at("2026-11-13"));
    expect(await family.listGoals(at("2026-11-13"))).toEqual([]);
    const again = await family.repeatGoal(goalId, "User 1", at("2026-11-14"));
    expect((await family.listGoals(at("2026-11-14")))[0]).toMatchObject({ id: again, progress: 0, startedOn: "2026-11-14" });

    const history = await family.choreHistory(at("2026-11-14"), 14);
    const leo = history.kids[0];
    expect(leo.goalsDone.map((x) => x.reward)).toEqual(["Roblox access"]);
    const read = leo.chores.find((c) => c.title === "Read 20 min")!;
    expect(read.best).toBe(3);
    expect(read.grid.filter((d) => d === "done")).toHaveLength(3);
  });

  it("refuses goals on one-time chores and silly targets", async () => {
    const once = await family.addChore({ kidId, title: "Clean garage", recurrence: "once" });
    await expect(family.createGoal({ kidId, choreId: once, kind: "streak", target: 5, reward: "x" }, "User 1")).rejects.toThrow(/daily or weekly/);
    await expect(family.createGoal({ kidId, choreId: readId, kind: "streak", target: 1, reward: "x" }, "User 1")).rejects.toThrow(/target/);
  });
});

describe("Ask Claude on the kitchen screen", () => {
  it("gets only what the kitchen screen shows, without notes or order numbers", async () => {
    await family.addReturn({ itemName: "Boots", store: "Target", returnDeadline: "2026-12-01", notes: "QR code in email", orderRef: "ORD-55821" });
    await family.addShoppingItem({ name: "Milk", store: "Costco" });
    const snap = await kitchenSnapshot(at("2026-11-14"));
    expect(Object.keys(snap).sort()).toEqual(["calendar", "kids", "returns", "shopping", "timeZone", "today", "upkeepDue"]);
    const text = JSON.stringify(snap);
    expect(text).toContain("Boots");
    expect(text).toContain("Milk");
    expect(text).toContain("Roblox access");
    expect(text).not.toContain("ORD-55821");
    expect(text).not.toContain("QR code");
  });

  it("asks with no tools and keeps it to kitchen topics", async () => {
    const answer = await askKitchen([{ role: "user", text: "hi" }], "Who still has chores?", at("2026-11-14"));
    expect(answer).toBe("Leo still has to brush teeth.");
    const call = sent.at(-1)!;
    expect(call.system).toMatch(/only know what is on the kitchen screen/);
    expect(call.system).toMatch(/money, bank or card accounts/);
    expect(call.task).toContain("Who still has chores?");
    expect(JSON.stringify(call.payload)).not.toMatch(/ORD-55821|account|balance/i);
  });
});
