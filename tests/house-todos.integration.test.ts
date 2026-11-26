import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/core/db/client";
import { freshDb } from "./helpers/db";

/** One-time house to-dos on the kitchen screen: Pavel's three, adding one, and "Defer until". */
let db: Db;
let api: typeof import("@/modules/maintenance/api");
const TODAY = "2026-11-26";
const horizon = "2026-12-10";

beforeAll(async () => {
  db = await freshDb();
  api = await import("@/modules/maintenance/api");
});

describe("house to-dos", () => {
  it("starts with Pavel's three, added today, once", async () => {
    // The migration already ran in freshDb; running it again adds nothing.
    await db.execute(sql.raw(readFileSync("drizzle/0032_house_todos_seed.sql", "utf8")));
    const due = (await api.listDueTasks(horizon, 50, { today: TODAY })).filter((t) => t.todo);
    expect(due.map((t) => [t.title, t.todo, t.assignee, t.dueDate])).toEqual([
      ["Replace the caulk on the kitchen counter", true, "Pavel", TODAY],
      ["Spackle over holes: pull-up bar, child gate, curtain rods", true, "Pavel", TODAY],
      ["Hide wires in Elana's room and Raya's office", true, "Pavel", TODAY],
    ]);
  });

  it("adds a to-do dated today, with who will do it", async () => {
    const id = await api.addHouseTodo({ title: "  Fix the gate latch ", assignee: " Raya ", today: TODAY });
    const t = (await api.listDueTasks(horizon, 50, { today: TODAY })).find((x) => x.id === id)!;
    expect(t).toMatchObject({ title: "Fix the gate latch", assignee: "Raya", todo: true, dueDate: TODAY, recurrenceDays: null });
    await expect(api.addHouseTodo({ title: "  ", today: TODAY })).rejects.toThrow(/what needs doing/i);
  });

  it("Defer until hides it until that day, and an earlier day brings it back", async () => {
    const [first] = (await api.listDueTasks(horizon, 50, { today: TODAY })).filter((t) => t.todo);
    await api.deferTask(first.id, "2026-12-01", TODAY);
    const ids = async (today: string) => (await api.listDueTasks(horizon, 50, { today })).map((t) => t.id);
    expect(await ids(TODAY)).not.toContain(first.id);
    expect(await ids("2026-11-30")).not.toContain(first.id);
    expect(await ids("2026-12-01")).toContain(first.id);
    await api.deferTask(first.id, TODAY, TODAY);
    expect(await ids(TODAY)).toContain(first.id);
    await expect(api.deferTask(first.id, "2028-01-01", TODAY)).rejects.toThrow(/next year/);
  });

  it("to-dos are left out of upkeep reminders, and done ones drop off", async () => {
    const taskId = await api.scheduleTask({ title: "Change furnace filter", dueDate: "2026-11-28", recurrenceDays: 90 });
    const reminders = await api.listDueTasks(horizon, 200, { today: TODAY, todos: false });
    expect(reminders.map((t) => t.id)).toContain(taskId);
    expect(reminders.some((t) => t.todo)).toBe(false);
    const [todo] = (await api.listDueTasks(horizon, 50, { today: TODAY })).filter((t) => t.todo);
    await api.completeTask(todo.id, { date: TODAY });
    expect((await api.listDueTasks(horizon, 50, { today: TODAY })).map((t) => t.id)).not.toContain(todo.id);
    // A one-off does not come back.
    expect((await api.listDueTasks("2030-01-01", 50)).filter((t) => t.title === todo.title)).toHaveLength(0);
  });
});
