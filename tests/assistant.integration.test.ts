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
    expect((await family.listShopping()).length).toBe(1);

    await expect(applyChangeset(TWO, id)).rejects.toThrow(/not found/); // only its owner
    await applyChangeset(ONE, id);
    expect((await family.listShopping()).length).toBe(0);

    await undoChangeset(ONE, id);
    const back = await family.listShopping();
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
