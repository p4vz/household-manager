import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";
import { registerModules } from "@/modules/registry";
import {
  addChore,
  addKid,
  addReturn,
  addShoppingItem,
  addStore,
  choreBoard,
  completeChore,
  createList,
  deferList,
  deleteList,
  deleteTemplate,
  itemKey,
  listReturns,
  listTemplates,
  moveShoppingItem,
  openItemCount,
  reorderLists,
  reorderStores,
  runHousekeeping,
  saveListAsTemplate,
  setReturnStatus,
  setShoppingChecked,
  shoppingBoard,
  storeItemsToBuy,
  undoChore,
  type ShoppingList,
} from "@/modules/family/api";
import { completeTask, listDueTasks, listOpenTasks, scheduleTask } from "@/modules/maintenance/api";
import { listUpcoming } from "@/modules/calendar/api";
import { createPairingCode, listKioskDevices, redeemPairingCode, revokeKioskDevice, verifyDeviceToken } from "@/core/kiosk/devices";

beforeAll(async () => {
  process.env.HOUSEHOLD_TIMEZONE = "America/New_York";
  await freshDb();
  registerModules();
});

// Monday 23 Nov 2026, 5 PM in New York.
const MON = new Date("2026-11-23T22:00:00Z");
const TUE = new Date("2026-11-24T22:00:00Z");
const TUE_1AM = new Date("2026-11-25T06:00:00Z"); // still Tuesday's chore day

describe("chore board", () => {
  it("ticks, resets by day, keeps one-time chores for the day they were done", async () => {
    const kid = await addKid({ name: "Ava" });
    const bed = await addChore({ kidId: kid, title: "Make bed", icon: "🛏️", recurrence: "daily", stars: 2 }, MON);
    const room = await addChore({ kidId: kid, title: "Tidy room", recurrence: "weekly" }, MON);
    const once = await addChore({ kidId: kid, title: "Return library book", recurrence: "once" }, MON);

    await completeChore(bed, MON);
    await completeChore(bed, MON); // idempotent
    await completeChore(room, MON);
    await completeChore(once, MON);
    let [ava] = await choreBoard(MON);
    expect(ava.chores.map((c) => [c.title, c.done])).toEqual([
      ["Make bed", true],
      ["Tidy room", true],
      ["Return library book", true],
    ]);
    expect(ava.stats).toMatchObject({ todayDone: 3, todayTotal: 3, starsWeek: 4, starsTotal: 4, streak: 1 });

    [ava] = await choreBoard(TUE);
    expect(ava.chores.map((c) => [c.title, c.done])).toEqual([
      ["Make bed", false], // new day
      ["Tidy room", true], // same week
    ]);

    await completeChore(bed, TUE_1AM);
    [ava] = await choreBoard(TUE);
    expect(ava.chores[0].done).toBe(true);
    expect(ava.stats.streak).toBe(2);

    await undoChore(bed, TUE);
    [ava] = await choreBoard(TUE);
    expect(ava.chores[0].done).toBe(false);
    expect(ava.stats.streak).toBe(1);
  });
});

describe("shopping", () => {
  const NOW = new Date("2026-11-23T22:00:00Z"); // Mon 23 Nov, New York
  const items = (l: ShoppingList) => l.sections.flatMap((s) => s.items.map((i) => `${s.store}:${i.name}${i.checked ? "✓" : ""}`));

  it("starts with the Weekly Sam's and Weekly Russian templates", async () => {
    const t = await listTemplates();
    expect(t.map((x) => [x.name, x.stores.map((s) => [s.store, s.items.map((i) => i.name)])])).toEqual([
      ["Weekly Sam's", [["Sam's Club", ["Milk", "Eggs", "Yogurt", "Berries", "Fruits"]]]],
      ["Weekly Russian", [["Russian store", ["Tvorog", "Snacks", "Eggs"]]]],
    ]);
  });

  it("ticks the same item off every active list, and un-ticks them together", async () => {
    const [sams, russian] = await listTemplates();
    const a = await createList({ templateId: sams.id });
    const b = await createList({ templateId: russian.id });
    let board = await shoppingBoard(NOW);
    expect(board.lists.map((l) => l.name)).toEqual(["Weekly Sam's", "Weekly Russian"]);
    const eggs = board.lists[0].sections[0].items.find((i) => i.name === "Eggs")!;

    const rev = board.revision;
    await setShoppingChecked(eggs.id, true, NOW);
    board = await shoppingBoard(NOW);
    expect(board.revision).toBeGreaterThan(rev);
    expect(items(board.lists[0])).toContain("Sam's Club:Eggs✓");
    expect(items(board.lists[1])).toContain("Russian store:Eggs✓");
    expect(items(board.lists[0])).toContain("Sam's Club:Milk");

    await setShoppingChecked(board.lists[1].sections[0].items.find((i) => i.name === "Eggs")!.id, false, NOW);
    board = await shoppingBoard(NOW);
    expect(items(board.lists[0])).toContain("Sam's Club:Eggs");
    expect(items(board.lists[1])).toContain("Russian store:Eggs");

    // Same name typed differently still matches.
    const extra = await addShoppingItem({ name: " EGGS. ", store: "Costco", listId: a }, NOW);
    await setShoppingChecked(extra, true, NOW);
    board = await shoppingBoard(NOW);
    expect(board.lists.flatMap((l) => l.sections.flatMap((s) => s.items)).filter((i) => itemKey(i.name) === "eggs").every((i) => i.checked)).toBe(true);

    await deleteList(a);
    await deleteList(b);
  });

  it("leaves deferred lists alone and brings them back on the date", async () => {
    const [sams] = await listTemplates();
    const now = await createList({ templateId: sams.id });
    const later = await createList({ name: "Next week", templateId: sams.id });
    await deferList(later, "2026-11-30");
    let board = await shoppingBoard(NOW);
    expect(board.lists.map((l) => l.id)).toEqual([now]);
    expect(board.deferred.map((l) => [l.id, l.deferredUntil])).toEqual([[later, "2026-11-30"]]);

    const milk = board.lists[0].sections[0].items.find((i) => i.name === "Milk")!;
    await setShoppingChecked(milk.id, true, NOW);
    board = await shoppingBoard(new Date("2026-11-30T15:00:00Z"));
    expect(board.lists.map((l) => l.id)).toEqual([now, later]);
    expect(items(board.lists[1])).toContain("Sam's Club:Milk"); // not ticked: it was put off

    await deleteList(now);
    await deleteList(later);
  });

  it("adds stores at the bottom, reorders them, and moves items between stores and lists", async () => {
    const list = await createList({ name: "Party" });
    const costco = await addStore(list, "Costco");
    const target = await addStore(list, "Target");
    expect(await addStore(list, "costco")).toBe(costco); // no duplicate store
    const cups = await addShoppingItem({ name: "Cups", store: "Costco", listId: list });
    const cake = await addShoppingItem({ name: "Cake", store: "Costco", listId: list });
    const plates = await addShoppingItem({ name: "Plates", store: "Costco", listId: list });
    expect(await addShoppingItem({ name: "cake", store: "Costco", listId: list })).toBe(cake); // no duplicate item

    await reorderStores(list, [target, costco]);
    await moveShoppingItem(plates, costco, 0);
    await moveShoppingItem(cups, target, 0);
    let l = (await shoppingBoard(NOW)).lists.find((x) => x.id === list)!;
    expect(l.sections.map((s) => [s.store, s.items.map((i) => i.name)])).toEqual([
      ["Target", ["Cups"]],
      ["Costco", ["Plates", "Cake"]],
    ]);

    const other = await createList({ name: "Other" });
    const otherStore = await addStore(other, "Giant");
    await moveShoppingItem(cake, otherStore, 5);
    l = (await shoppingBoard(NOW)).lists.find((x) => x.id === other)!;
    expect(items(l)).toEqual(["Giant:Cake"]);

    await reorderLists([other, list]);
    expect((await shoppingBoard(NOW)).lists.map((x) => x.name).slice(0, 2)).toEqual(["Other", "Party"]);
    await deleteList(list);
    await deleteList(other);
  });

  it("saves a list as a template (same name replaces) and starts lists from it", async () => {
    const list = await createList({ name: "Camping" });
    await addShoppingItem({ name: "Marshmallows", store: "Target", listId: list });
    await addShoppingItem({ name: "Water", store: "Costco", quantity: "2", listId: list });
    const t1 = await saveListAsTemplate(list, "Camping");
    await addShoppingItem({ name: "Ice", store: "Costco", listId: list });
    const t2 = await saveListAsTemplate(list, "Camping");
    expect(t2).toBe(t1);
    const tpl = (await listTemplates()).find((t) => t.id === t1)!;
    expect(tpl.stores).toEqual([
      { store: "Target", items: [{ name: "Marshmallows", quantity: null }] },
      { store: "Costco", items: [{ name: "Water", quantity: "2" }, { name: "Ice", quantity: null }] },
    ]);
    const copy = await createList({ templateId: t1 });
    const l = (await shoppingBoard(NOW)).lists.find((x) => x.id === copy)!;
    expect(items(l)).toEqual(["Target:Marshmallows", "Costco:Water", "Costco:Ice"]);
    expect((await shoppingBoard(NOW)).stores).toContain("Russian store");

    await deleteTemplate(t1);
    await deleteList(list);
    await deleteList(copy);
  });

  it("a bare add goes to the first active list, creating one when there is none", async () => {
    const id = await addShoppingItem({ name: "Batteries", store: "Target" }, NOW);
    const board = await shoppingBoard(NOW);
    expect(board.lists.map((l) => [l.name, items(l)])).toEqual([["Shopping", ["Target:Batteries"]]]);
    expect(openItemCount(board)).toBe(1);
    expect(storeItemsToBuy(board, "Target")).toEqual([{ name: "Batteries", quantity: null }]);
    await setShoppingChecked(id, true, new Date("2026-11-20T10:00:00Z"));
  });

  it("housekeeping clears ticked items after 12 hours, and a list left empty", async () => {
    expect((await runHousekeeping(new Date("2026-11-20T21:00:00Z"))).shoppingCleared).toBe(0);
    expect((await runHousekeeping(new Date("2026-11-20T23:00:00Z"))).shoppingCleared).toBe(1);
    expect((await shoppingBoard(NOW)).lists).toEqual([]);
  });
});

describe("returns", () => {
  it("tracks status and refuses card numbers", async () => {
    const id = await addReturn({ itemName: "Boots", store: "Target", returnDeadline: "2026-11-30", orderRef: "112-1234567-1234567" });
    await setReturnStatus(id, "packed_in_car");
    expect((await listReturns())[0]).toMatchObject({ itemName: "Boots", status: "packed_in_car" });
    await setReturnStatus(id, "returned");
    expect(await listReturns()).toHaveLength(0);
    expect(await listReturns({ includeReturned: true })).toHaveLength(1);
    await expect(addReturn({ itemName: "Shirt", store: "Target", notes: "card 4111 1111 1111 1111" })).rejects.toThrow(/card number/);
  });
});

describe("upkeep from the kitchen", () => {
  it("completing a repeating task schedules the next one and puts it on the calendar", async () => {
    const id = await scheduleTask({ title: "HVAC filter", dueDate: "2026-11-20", recurrenceDays: 90 });
    expect((await listDueTasks("2026-11-23")).map((t) => t.title)).toContain("HVAC filter");
    const { nextTaskId } = await completeTask(id, { date: "2026-11-23" });
    expect(nextTaskId).toBeTruthy();
    const open = await listOpenTasks();
    expect(open.find((t) => t.id === nextTaskId)).toMatchObject({ dueDate: "2027-02-21", recurrenceDays: 90 });
    expect(await listUpcoming("2027-02-01")).toContainEqual(expect.objectContaining({ title: "Maintenance: HVAC filter", startDate: "2027-02-21" }));
    // Ticking twice (two screens) does not schedule two.
    expect((await completeTask(id, { date: "2026-11-23" })).nextTaskId).toBeNull();
  });
});

describe("kiosk pairing", () => {
  it("a code works once, before it expires, and unpairing ends access", async () => {
    const now = new Date("2026-11-23T18:00:00Z");
    const { code } = await createPairingCode("User 1", now);
    expect(await redeemPairingCode(code, "Kitchen", new Date(now.getTime() + 11 * 60_000))).toBeNull(); // expired

    const fresh = await createPairingCode("User 1", now);
    const token = await redeemPairingCode(fresh.code.toLowerCase(), "Kitchen", now);
    expect(token).toBeTruthy();
    expect(await redeemPairingCode(fresh.code, "Second", now)).toBeNull(); // used

    const device = await verifyDeviceToken(token!);
    expect(device).toMatchObject({ name: "Kitchen" });
    expect(await verifyDeviceToken(`${token!.slice(0, -1)}A`)).toBeNull();

    const [listed] = await listKioskDevices();
    await revokeKioskDevice(listed.id);
    expect(await verifyDeviceToken(token!)).toBeNull();
  });
});
