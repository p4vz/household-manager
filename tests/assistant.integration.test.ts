import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeAccounts, financeTransactions } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

vi.mock("@/core/net/outbound", () => ({ outboundFetch: async () => new Response("{}", { status: 404 }) }));

const { registerModules } = await import("@/modules/registry");
const family = await import("@/modules/family/api");
const maintenance = await import("@/modules/maintenance/api");
const { applyChangeset, discardChangeset, listChangesets, recordChangeset, undoChange, undoChangeset, DraftBook, MAX_CHANGES_PER_BATCH } =
  await import("@/assistant/changesets");
const { RefBook } = await import("@/assistant/conversations");
const { TOOLS, runTool } = await import("@/assistant/tools");
const { needsApproval, AUTO_APPLY_MAX } = await import("@/assistant/policy");
type Ctx = import("@/assistant/entities").AssistantCtx;

const NOW = new Date("2026-11-25T17:00:00Z");
const ONE: Ctx = { email: "one@example.com", owner: "User 1", viewer: "user1", now: NOW };
const TWO: Ctx = { email: "two@example.com", owner: "User 2", viewer: "user2", now: NOW };

let mine: string, joint: string, hers: string;

beforeEach(async () => {
  const db = await freshDb();
  registerModules();
  vi.stubEnv("HOUSEHOLD_TIMEZONE", "America/New_York");
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "Pat Example");
  const [a, b, c] = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Sapphire", owner: "user1", kind: "credit" },
      { bankName: "Joint Checking", owner: "joint", kind: "checking" },
      { bankName: "Her Card", owner: "user2", kind: "credit" },
    ])
    .returning();
  [mine, joint, hers] = [a.id, b.id, c.id];
  let n = 0;
  const txn = (accountId: string, postedDate: string, amount: number, merchant: string, category: string | null, description = merchant) => ({
    accountId,
    source: "csv" as const,
    externalId: `x${n++}`,
    postedDate,
    amount,
    merchant,
    description,
    category,
  });
  await db.insert(financeTransactions).values([
    txn(mine, "2026-11-02", -48.1, "Shell", null),
    txn(mine, "2026-11-03", -12, "Shell", "Gas"),
    txn(joint, "2026-11-04", -220, "Home Depot", null, "HOME DEPOT card ending in 4321 Pat Example"),
    txn(hers, "2026-11-05", -90, "Sephora", null),
  ]);
});

function env(ctx: Ctx, refs = new RefBook({}, 1)) {
  return { ctx, refs, drafts: new DraftBook() };
}

async function call(name: string, args: unknown, e: ReturnType<typeof env>) {
  const t = TOOLS.find((x) => x.name === name)!;
  return JSON.parse(await runTool(t, args, e));
}

describe("reads", () => {
  it("show only joint and own accounts, with refs and no ids, names or card digits", async () => {
    const e = env(ONE);
    const out = await call("search_transactions", {}, e);
    const merchants = out.transactions.map((t: { merchant: string }) => t.merchant).sort();
    expect(merchants).toEqual(["Home Depot", "Shell", "Shell"]);
    const raw = JSON.stringify(out);
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no database ids
    expect(raw).not.toContain("Sephora");
    expect(raw).not.toContain("Pat");
    expect(raw).not.toContain("4321");
    expect(out.transactions[0].ref).toMatch(/^t\d+$/);

    const accounts = await call("list_accounts", {}, e);
    expect(accounts.map((a: { name: string }) => a.name).sort()).toEqual(["Joint Checking", "Sapphire"]);

    const hersView = await call("search_transactions", {}, env(TWO));
    expect(hersView.transactions.map((t: { merchant: string }) => t.merchant).sort()).toEqual(["Home Depot", "Sephora"]);
  });

  it("refuses refs it never handed out, or of another kind", async () => {
    const e = env(ONE);
    await call("shopping_list", {}, e);
    const out = await call("edit_transactions", { refs: ["t99"], category: "Gas" }, e);
    expect(out.error).toMatch(/Unknown transaction/);
  });

  it("can't reach the other member's transaction even with a ref to it", async () => {
    const refs = new RefBook({}, 1);
    const [herTxn] = (await (await import("@/core/db/client")).db().select().from(financeTransactions)).filter((t) => t.accountId === hers);
    const ref = refs.ref("transaction", herTxn.id);
    const out = await call("edit_transactions", { refs: [ref], category: "Shopping" }, env(ONE, refs));
    expect(out.error).toMatch(/not visible/);
  });
});

describe("small fixes apply at once and undo", () => {
  it("recategorizes, then undoes per change and per batch", async () => {
    const e = env(ONE);
    const { transactions } = await call("search_transactions", { text: "shell" }, e);
    const refs = transactions.map((t: { ref: string }) => t.ref);
    const res = await call("edit_transactions", { refs, category: "Auto & Transport", subcategory: "Gas" }, e);
    expect(res.queued).toBe(2);

    const id = (await recordChangeset(ONE, null, "fix gas", e.drafts.drafts))!;
    let [set] = await listChangesets(ONE, { ids: [id] });
    expect(set.autoApplied).toBe(true);
    expect(set.status).toBe("applied");
    expect(set.changes.map((c) => c.before?.category ?? null).sort()).toEqual(["Gas", null]);

    let after = await call("search_transactions", { text: "shell" }, e);
    expect(after.transactions.every((t: { category: string }) => t.category === "Auto & Transport")).toBe(true);

    await undoChange(ONE, set.changes[0].id);
    [set] = await listChangesets(ONE, { ids: [id] });
    expect(set.status).toBe("partial");

    await undoChangeset(ONE, id);
    [set] = await listChangesets(ONE, { ids: [id] });
    expect(set.status).toBe("undone");
    after = await call("search_transactions", { text: "shell" }, e);
    expect(after.transactions.map((t: { category: string | null }) => t.category).sort()).toEqual(["Gas", null]);
  });

  it("leaves a row alone on undo if someone changed it again", async () => {
    const e = env(ONE);
    const { transactions } = await call("search_transactions", { text: "home depot" }, e);
    await call("edit_transactions", { refs: [transactions[0].ref], category: "Home" }, e);
    const id = (await recordChangeset(ONE, null, "x", e.drafts.drafts))!;
    await call("edit_transactions", { refs: [transactions[0].ref], category: "Home Improvement" }, env(ONE, e.refs));
    const manual = e.refs; // the member edits it by hand
    const fin = await import("@/modules/finance/api");
    await fin.updateTransactionFields("user1", manual.resolve(transactions[0].ref, "transaction"), { category: "Repairs" });

    await undoChangeset(ONE, id);
    const [set] = await listChangesets(ONE, { ids: [id] });
    expect(set.changes[0].status).toBe("undo_conflict");
    const now = await call("search_transactions", { text: "home depot" }, e);
    expect(now.transactions[0].category).toBe("Repairs");
  });
});

describe("approval", () => {
  it("deletes wait for Apply; Undo brings the item back", async () => {
    await family.addShoppingItem({ name: "Milk", store: "Costco" });
    const e = env(ONE);
    const [item] = await call("shopping_list", {}, e);
    await call("edit_shopping_item", { action: "delete", ref: item.ref }, e);
    expect(needsApproval(e.drafts.drafts)).toBe(true);
    const id = (await recordChangeset(ONE, null, "remove milk", e.drafts.drafts))!;
    expect((await family.listShoppingItems()).length).toBe(1);

    await expect(applyChangeset(TWO, id)).rejects.toThrow(/not found/); // only its owner
    await applyChangeset(ONE, id);
    expect((await family.listShoppingItems()).length).toBe(0);

    await undoChangeset(ONE, id);
    const back = await family.listShoppingItems();
    expect(back.map((i) => [i.name, i.store])).toEqual([["Milk", "Costco"]]);
  });

  it("big batches wait; rows changed meanwhile are skipped as conflicts; discard changes nothing", async () => {
    for (let i = 0; i < AUTO_APPLY_MAX + 1; i++) await maintenance.scheduleTask({ title: `Task ${i}`, dueDate: "2026-12-01" });
    const e = env(ONE);
    const tasks = await call("upkeep_tasks", {}, e);
    for (const t of tasks) await call("edit_upkeep_task", { action: "update", ref: t.ref, dueDate: "2026-12-15" }, e);
    const id = (await recordChangeset(ONE, null, "push back", e.drafts.drafts))!;
    let [set] = await listChangesets(ONE, { ids: [id] });
    expect(set.status).toBe("proposed");

    const first = e.refs.resolve(tasks[0].ref, "upkeep_task");
    await maintenance.updateTask(first, { dueDate: "2026-12-03" });
    await applyChangeset(ONE, id);
    [set] = await listChangesets(ONE, { ids: [id] });
    expect(set.status).toBe("partial");
    expect(set.changes.filter((c) => c.status === "conflict")).toHaveLength(1);
    expect((await maintenance.getTask(first))!.dueDate).toBe("2026-12-03");

    const e2 = env(ONE, e.refs);
    await call("edit_upkeep_task", { action: "delete", ref: tasks[1].ref }, e2);
    const id2 = (await recordChangeset(ONE, null, "drop", e2.drafts.drafts))!;
    await discardChangeset(ONE, id2);
    expect(await maintenance.getTask(e.refs.resolve(tasks[1].ref, "upkeep_task"))).not.toBeNull();
  });

  it("caps a batch", () => {
    const d = new DraftBook();
    for (let i = 0; i < MAX_CHANGES_PER_BATCH; i++) d.add({ entity: "transaction", op: "update", key: `k${i}`, label: "", before: {}, after: {} });
    expect(() => d.add({ entity: "transaction", op: "update", key: "extra", label: "", before: {}, after: {} })).toThrow(/At most/);
  });

  it("chores: tick applies at once, archive waits and undo restores", async () => {
    const kid = await family.addKid({ name: "Ava" });
    await family.addChore({ kidId: kid, title: "Make bed", recurrence: "daily" }, NOW);
    const e = env(ONE);
    const [board] = await call("chores", {}, e);
    await call("edit_chore", { ref: board.chores[0].ref, action: "mark_done" }, e);
    await recordChangeset(ONE, null, "done", e.drafts.drafts);
    expect((await family.choreBoard(NOW))[0].chores[0].done).toBe(true);

    const e2 = env(ONE, e.refs);
    await call("edit_chore", { ref: board.chores[0].ref, action: "archive" }, e2);
    const id = (await recordChangeset(ONE, null, "archive", e2.drafts.drafts))!;
    await applyChangeset(ONE, id);
    expect((await family.choreBoard(NOW))[0].chores).toHaveLength(0);
    await undoChangeset(ONE, id);
    expect((await family.choreBoard(NOW))[0].chores).toHaveLength(1);
  });
});

describe("merchant rules", () => {
  it("creates a rule and undo removes it", async () => {
    const e = env(ONE);
    await call("set_merchant_rule", { merchant: "Shell", category: "Auto & Transport", subcategory: "Gas" }, e);
    const id = (await recordChangeset(ONE, null, "rule", e.drafts.drafts))!;
    expect(await call("merchant_rule", { merchant: "Shell" }, e)).toEqual({ category: "Auto & Transport", subcategory: "Gas" });
    await undoChangeset(ONE, id);
    expect(await call("merchant_rule", { merchant: "Shell" }, e)).toBeNull();
  });
});

describe("creating and completing across the household", () => {
  it("chores: create by kid name, edit, and undo archives the new one", async () => {
    await family.addKid({ name: "Ava" });
    const e = env(ONE);
    await call("edit_chore", { action: "create", kid: "ava", title: "Read 20 min", icon: "📚", recurrence: "daily", stars: 2 }, e);
    const id = (await recordChangeset(ONE, null, "chore", e.drafts.drafts))!;
    let [board] = await family.choreBoard(NOW);
    expect(board.chores.map((c) => [c.title, c.recurrence, c.stars])).toEqual([["Read 20 min", "daily", 2]]);

    const e2 = env(ONE, e.refs);
    const [b] = await call("chores", {}, e2);
    await call("edit_chore", { action: "update", ref: b.chores[0].ref, title: "Read 30 min", recurrence: "weekly" }, e2);
    const id2 = (await recordChangeset(ONE, null, "rename", e2.drafts.drafts))!;
    [board] = await family.choreBoard(NOW);
    expect(board.chores[0]).toMatchObject({ title: "Read 30 min", recurrence: "weekly" });
    await undoChangeset(ONE, id2);
    [board] = await family.choreBoard(NOW);
    expect(board.chores[0]).toMatchObject({ title: "Read 20 min", recurrence: "daily" });

    await undoChangeset(ONE, id);
    expect((await family.choreBoard(NOW))[0].chores).toHaveLength(0);
    const missing = await call("edit_chore", { action: "create", kid: "Zed", title: "x" }, env(ONE));
    expect(missing.queued).toBe(1); // checked when applied
  });

  it("goals: a chore and its goal in one reply; reward given and undone", async () => {
    await family.addKid({ name: "Ava" });
    const e = env(ONE);
    await call("edit_chore", { action: "create", kid: "Ava", title: "Read", recurrence: "daily" }, e);
    await call("edit_chore_goal", { action: "create", kid: "Ava", chore: "read", kind: "streak", target: 10, reward: "Prize" }, e);
    const id = (await recordChangeset(ONE, null, "goal", e.drafts.drafts))!;
    const [set] = await listChangesets(ONE, { ids: [id] });
    expect(set.changes.map((c) => c.status)).toEqual(["applied", "applied"]);
    const goals = await call("chore_goals", {}, env(ONE, e.refs));
    expect(goals).toMatchObject([{ kid: "Ava", chore: "Read", target: 10, reward: "Prize", rewardGiven: false }]);

    const e2 = env(ONE, e.refs);
    await call("edit_chore_goal", { action: "update", ref: goals[0].ref, target: 30, reward: "Roblox" }, e2);
    await recordChangeset(ONE, null, "bigger", e2.drafts.drafts);
    expect((await call("chore_goals", {}, e2))[0]).toMatchObject({ target: 30, reward: "Roblox" });

    const e3 = env(ONE, e.refs);
    await call("edit_chore_goal", { action: "archive", ref: goals[0].ref }, e3);
    const id3 = (await recordChangeset(ONE, null, "archive", e3.drafts.drafts))!;
    await applyChangeset(ONE, id3);
    expect(await call("chore_goals", {}, e3)).toEqual([]);
    await undoChangeset(ONE, id3);
    expect(await call("chore_goals", {}, e3)).toHaveLength(1);
  });

  it("shopping: a new list with items, a template from it, and undo of a deleted list", async () => {
    const e = env(ONE);
    await call("edit_shopping_list", { action: "create", name: "Party" }, e);
    await call("edit_shopping_item", { action: "create", name: "Balloons", store: "Target", list: "Party" }, e);
    await call("edit_shopping_item", { action: "create", name: "Cake", store: "Costco", quantity: "1", list: "Party" }, e);
    await recordChangeset(ONE, null, "party", e.drafts.drafts);
    const lists = await call("shopping_lists", {}, e);
    const party = lists.lists.find((l: { name: string }) => l.name === "Party");
    expect(party.stores.map((s: { store: string; left: number }) => [s.store, s.left]).sort()).toEqual([["Costco", 1], ["Target", 1]]);

    const e2 = env(ONE, e.refs);
    await call("edit_shopping_template", { action: "create", name: "Party kit", fromListRef: party.ref }, e2);
    await recordChangeset(ONE, null, "template", e2.drafts.drafts);
    const tpl = (await family.listTemplates()).find((t) => t.name === "Party kit")!;
    expect(tpl.stores.flatMap((s) => s.items.map((i) => i.name)).sort()).toEqual(["Balloons", "Cake"]);

    const e3 = env(ONE, e.refs);
    await call("edit_shopping_list", { action: "create", name: "Next party", template: "Party kit", deferredUntil: "2026-12-20" }, e3);
    await call("edit_shopping_list", { action: "delete", ref: party.ref }, e3);
    const id3 = (await recordChangeset(ONE, null, "swap", e3.drafts.drafts))!;
    await applyChangeset(ONE, id3);
    const board = await family.shoppingBoard(NOW);
    expect(board.lists.map((l) => l.name)).not.toContain("Party");
    expect(board.deferred.map((l) => [l.name, l.deferredUntil])).toEqual([["Next party", "2026-12-20"]]);

    await undoChangeset(ONE, id3);
    const back = await family.shoppingBoard(NOW);
    const restored = back.lists.find((l) => l.name === "Party")!;
    expect(restored.sections.flatMap((s) => s.items.map((i) => i.name)).sort()).toEqual(["Balloons", "Cake"]);
    expect(back.deferred).toHaveLength(0);
  });

  it("upkeep: complete schedules the next one; reopen undoes both", async () => {
    await maintenance.scheduleTask({ title: "Furnace filter", dueDate: "2026-11-20", recurrenceDays: 90 });
    const e = env(ONE);
    const task = (await call("upkeep_tasks", {}, e)).find((t: { title: string }) => t.title === "Furnace filter");
    await call("edit_upkeep_task", { action: "complete", ref: task.ref, completedOn: "2026-11-24", actualCost: 25 }, e);
    const id = (await recordChangeset(ONE, null, "done", e.drafts.drafts))!;
    const filters = async () => (await maintenance.listTasks({ completedSince: "2026-11-01" })).filter((t) => t.title === "Furnace filter");
    let tasks = await filters();
    expect(tasks.map((t) => [t.dueDate, t.completedOn, t.actualCost]).sort()).toEqual([
      ["2026-11-20", "2026-11-24", 25],
      ["2027-02-22", null, null],
    ]);
    await undoChangeset(ONE, id);
    tasks = await filters();
    expect(tasks.map((t) => [t.dueDate, t.completedOn, t.actualCost])).toEqual([["2026-11-20", null, null]]);

    const e2 = env(ONE, e.refs);
    await call("edit_upkeep_task", { action: "complete", ref: task.ref }, e2);
    await recordChangeset(ONE, null, "done today", e2.drafts.drafts);
    const e3 = env(ONE, e.refs);
    await call("edit_upkeep_task", { action: "reopen", ref: task.ref }, e3);
    await recordChangeset(ONE, null, "oops", e3.drafts.drafts);
    expect((await filters()).map((t) => t.completedOn)).toEqual([null]);
  });

  it("home binder: add, and delete with undo; entries with a file are not deleted", async () => {
    const e = env(ONE);
    await call("edit_binder_entry", { action: "create", category: "warranty", title: "Dishwasher warranty", provider: "Bosch", expiresOn: "2028-03-01" }, e);
    await recordChangeset(ONE, null, "binder", e.drafts.drafts);
    const [entry] = await call("home_binder", {}, e);
    expect(entry).toMatchObject({ category: "warranty", title: "Dishwasher warranty", hasFile: false });
    const e2 = env(ONE, e.refs);
    await call("edit_binder_entry", { action: "delete", ref: entry.ref }, e2);
    const id = (await recordChangeset(ONE, null, "drop", e2.drafts.drafts))!;
    await applyChangeset(ONE, id);
    expect(await maintenance.listBinder()).toHaveLength(0);
    await undoChangeset(ONE, id);
    expect((await maintenance.listBinder()).map((d) => d.title)).toEqual(["Dishwasher warranty"]);
  });

  it("calendar: drafts a timed event and checks the times", async () => {
    const e = env(ONE);
    const ok = await call("edit_calendar_event", { action: "create", title: "Dentist", startDate: "2026-12-01", startTime: "15:00", endTime: "16:00" }, e);
    expect(ok.queued).toBe(1);
    expect(e.drafts.drafts[0].after).toMatchObject({ allDay: false, endDate: "2026-12-01", startTime: "15:00" });
    const allDay = await call("edit_calendar_event", { action: "create", title: "School closed", startDate: "2026-12-02" }, e);
    expect(allDay.changesInThisReply).toBe(2);
    expect(e.drafts.drafts[1].after).toMatchObject({ allDay: true });
    const bad = await call("edit_calendar_event", { action: "create", title: "x", startDate: "2026-12-01", startTime: "3pm", endTime: "4pm" }, e);
    expect(bad.error).toMatch(/HH:MM/);
  });

  it("photo text is scrubbed before it reaches Claude", async () => {
    const { withPhotoText } = await import("@/assistant/inbox");
    const msg = withPhotoText("Add this", "Field trip Dec 3. Pay with card 4111 1111 1111 1111. Pat Example", ["Pat Example"]);
    expect(msg).toContain("PHOTO TEXT");
    expect(msg).toContain("Field trip");
    expect(msg).not.toContain("4111 1111 1111 1111");
    expect(msg).not.toContain("Pat Example");
  });
});

describe("kids", () => {
  it("adds a kid and their chores in one reply; remove waits and undo brings them back", async () => {
    const e = env(ONE);
    await call("edit_kid", { action: "create", name: "Elana", emoji: "🌸" }, e);
    await call("edit_chore", { action: "create", kid: "Elana", title: "Read 30 min", stars: 5 }, e);
    await call("edit_chore", { action: "create", kid: "Elana", title: "Make bed", stars: 1 }, e);
    await recordChangeset(ONE, null, "setup", e.drafts.drafts);
    const [board] = await family.choreBoard(NOW);
    expect([board.name, board.emoji, board.chores.map((c) => [c.title, c.stars])]).toEqual(["Elana", "🌸", [["Read 30 min", 5], ["Make bed", 1]]]);

    const bad = await call("edit_kid", { action: "create", name: "Elana Example2" }, env(ONE));
    expect(bad.error).toMatch(/first name/);

    const e2 = env(ONE, e.refs);
    const [k] = await call("chores", {}, e2);
    await call("edit_kid", { action: "remove", ref: k.kidRef }, e2);
    const id = (await recordChangeset(ONE, null, "remove", e2.drafts.drafts))!;
    expect((await listChangesets(ONE, { ids: [id] }))[0].status).toBe("proposed");
    await applyChangeset(ONE, id);
    expect(await family.choreBoard(NOW)).toHaveLength(0);
    await undoChangeset(ONE, id);
    expect((await family.choreBoard(NOW))[0].chores).toHaveLength(2);
  });
});
