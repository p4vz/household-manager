import { beforeAll, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers/db";

/**
 * Claude is never called for real. The fake turn records what it was given
 * and, when asked to, uses the tools it was handed the way the model would.
 */
type Turn = import("@/assistant/agent").TurnOptions;
const sent: Turn[] = [];
let script: ((opts: Turn) => Promise<void>) | null = null;
vi.mock("@/assistant/agent", async () => {
  const { DraftBook } = await import("@/assistant/changesets");
  return {
    peopleLine: () => "",
    runAssistantTurn: vi.fn(async (opts: Turn) => {
      sent.push(opts);
      const drafts = new DraftBook();
      if (script) {
        const env = { ctx: opts.ctx, refs: opts.refs, drafts };
        const call = async (name: string, args: unknown) => {
          const t = opts.tools!.find((x) => x.name === name);
          if (!t) return { error: `no tool ${name}` };
          const { runTool } = await import("@/assistant/tools");
          return JSON.parse(await runTool(t, args, env));
        };
        (opts as Turn & { call: typeof call }).call = call;
        await script(opts);
      }
      return { reply: "Leo still has to brush teeth.", drafts };
    }),
  };
});

const family = await import("@/modules/family/api");
const { askKitchen, kitchenChange, kitchenSnapshot } = await import("@/assistant/kitchen");

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

  it("keeps it to kitchen topics and kitchen tools", async () => {
    const { answer, changes } = await askKitchen([{ role: "user", text: "hi" }], "Who still has chores?", at("2026-11-14"));
    expect(answer).toBe("Leo still has to brush teeth.");
    expect(changes).toBeNull();
    const call = sent.at(-1)!;
    expect(call.system).toMatch(/only know what is on the kitchen screen/);
    expect(call.system).toMatch(/money, bank or card accounts/);
    expect(call.userText).toContain("Who still has chores?");
    expect(call.tier).toBe("fast");
    const names = call.tools!.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "calendar",
        "chore_goals",
        "chores",
        "edit_calendar_event",
        "edit_chore",
        "edit_chore_goal",
        "edit_purchase_return",
        "edit_shopping_item",
        "edit_shopping_list",
        "edit_shopping_template",
        "edit_upkeep_task",
        "purchase_returns",
        "shopping_list",
        "shopping_lists",
        "upkeep_tasks",
      ].sort(),
    );
    expect(call.system).not.toMatch(/ORD-55821|balance/i);
    expect(() => call.ctx.viewer).toThrow(/not available on the kitchen screen/);
  });

  it("adds a chore with a goal from the screen, with undo; deletes other than events are refused", async () => {
    type WithCall = Turn & { call: (name: string, args: unknown) => Promise<Record<string, unknown>> };
    script = async (opts) => {
      const { call } = opts as WithCall;
      await call("edit_chore", { action: "create", kid: "leo", title: "Feed the cat", icon: "🐱", recurrence: "daily" });
      await call("edit_chore_goal", { action: "create", kid: "Leo", chore: "Feed the cat", kind: "count", target: 5, reward: "Ice cream" });
    };
    const { changes } = await askKitchen([], "Add a daily feed the cat chore for Leo, ice cream after 5 times", at("2026-11-14"), "Card 4111 1111 1111 1111 flyer");
    expect(sent.at(-1)!.userText).toContain("PHOTO TEXT");
    expect(sent.at(-1)!.userText).not.toContain("4111 1111 1111 1111");
    expect(changes!.status).toBe("applied");
    expect(changes!.changes.map((c) => c.entity)).toEqual(["chore", "chore_goal"]);
    const board = await family.choreBoard(at("2026-11-14"));
    expect(board[0].chores.map((c) => c.title)).toContain("Feed the cat");
    expect((await family.listGoals(at("2026-11-14"))).map((g) => g.reward)).toContain("Ice cream");

    // Undo from the screen takes both back.
    const after = await kitchenChange("undo", changes!.id, changes!.id);
    expect(after!.status).toBe("undone");
    expect((await family.choreBoard(at("2026-11-14")))[0].chores.map((c) => c.title)).not.toContain("Feed the cat");

    // A member sees the kitchen's changesets in their own history.
    const { listChangesets } = await import("@/assistant/changesets");
    const member = { email: "one@example.com", owner: "User 1" as const, viewer: "user1" as const, now: at("2026-11-14") };
    expect((await listChangesets(member)).map((c) => c.id)).toContain(changes!.id);

    let refused: unknown = null;
    script = async (opts) => {
      const { call } = opts as WithCall;
      const [kid] = await call("chores", {}) as unknown as { chores: { ref: string }[] }[];
      refused = await call("edit_chore", { action: "archive", ref: kid.chores[0].ref });
    };
    const r = await askKitchen([], "Archive a chore", at("2026-11-14"));
    expect(r.changes).toBeNull();
    expect(JSON.stringify(refused)).toMatch(/phone app/);
    script = null;
  });
});
