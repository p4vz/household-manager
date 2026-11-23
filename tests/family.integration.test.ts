import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";
import { registerModules } from "@/modules/registry";
import {
  addChore,
  addKid,
  addReturn,
  addShoppingItem,
  choreBoard,
  completeChore,
  listReturns,
  listShopping,
  restockStaples,
  runHousekeeping,
  setReturnStatus,
  setShoppingChecked,
  undoChore,
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
    const bed = await addChore({ kidId: kid, title: "Make bed", icon: "🛏️", recurrence: "daily", stars: 2 });
    const room = await addChore({ kidId: kid, title: "Tidy room", recurrence: "weekly" });
    const once = await addChore({ kidId: kid, title: "Return library book", recurrence: "once" });

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
  it("restocking puts staples back and clears bought one-time items", async () => {
    const milk = await addShoppingItem({ name: "Milk", store: "Costco", isStaple: true });
    const cake = await addShoppingItem({ name: "Birthday cake", store: "Costco" });
    const eggs = await addShoppingItem({ name: "Eggs", store: "Giant", isStaple: true });
    await setShoppingChecked(milk, true);
    await setShoppingChecked(cake, true);
    await setShoppingChecked(eggs, true);
    await restockStaples("Costco");
    const items = await listShopping();
    expect(items.find((i) => i.id === milk)?.checked).toBe(false);
    expect(items.find((i) => i.id === cake)).toBeUndefined();
    expect(items.find((i) => i.id === eggs)?.checked).toBe(true); // other store untouched
  });

  it("housekeeping clears bought one-time items after 12 hours", async () => {
    const id = await addShoppingItem({ name: "Batteries", store: "Target" });
    await setShoppingChecked(id, true, new Date("2026-11-20T10:00:00Z"));
    expect((await runHousekeeping(new Date("2026-11-20T21:00:00Z"))).shoppingCleared).toBe(0);
    expect((await runHousekeeping(new Date("2026-11-20T23:00:00Z"))).shoppingCleared).toBe(1);
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
