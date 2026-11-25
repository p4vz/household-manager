import { describe, expect, it } from "vitest";
import { isDeferred, itemKey, nudge, placeAt } from "@/modules/family/shopping-core";
import { addItem, deferLocal, moveItem, toggleItem, type ShoppingBoard } from "@/modules/family/ui/shopping-board";

const board = (): ShoppingBoard => ({
  revision: 1,
  templates: [],
  stores: [],
  deferred: [{ id: "L3", name: "Later", deferredUntil: "2026-12-01", sections: [{ id: "S4", store: "Giant", items: [{ id: "i6", name: "Eggs", quantity: null, checked: false }] }] }],
  lists: [
    {
      id: "L1",
      name: "Weekly Sam's",
      deferredUntil: null,
      sections: [
        { id: "S1", store: "Sam's Club", items: [{ id: "i1", name: "Milk", quantity: null, checked: false }, { id: "i2", name: "Eggs", quantity: null, checked: false }] },
        { id: "S2", store: "Costco", items: [] },
      ],
    },
    { id: "L2", name: "Weekly Russian", deferredUntil: null, sections: [{ id: "S3", store: "Russian store", items: [{ id: "i3", name: "eggs", quantity: null, checked: false }] }] },
  ],
});

describe("shopping helpers", () => {
  it("matches items by name regardless of case, spacing and punctuation", () => {
    expect(itemKey("  Eggs. ")).toBe("eggs");
    expect(itemKey("Sour  cream")).toBe(itemKey("sour-cream"));
    expect(itemKey("Milk")).not.toBe(itemKey("Milk 2%"));
  });

  it("orders ids", () => {
    expect(placeAt(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(placeAt(["a", "b"], "x", 9)).toEqual(["a", "b", "x"]);
    expect(nudge(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(nudge(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });

  it("treats a list as deferred only before its date", () => {
    expect(isDeferred("2026-12-01", "2026-11-30")).toBe(true);
    expect(isDeferred("2026-12-01", "2026-12-01")).toBe(false);
    expect(isDeferred(null, "2026-12-01")).toBe(false);
  });

  it("ticks on screen across active lists but not deferred ones", () => {
    const b = toggleItem(board(), "i2", true);
    expect(b.lists[1].sections[0].items[0].checked).toBe(true);
    expect(b.lists[0].sections[0].items[0].checked).toBe(false);
    expect(b.deferred[0].sections[0].items[0].checked).toBe(false);
  });

  it("moves, adds and defers on screen", () => {
    let b = moveItem(board(), "i2", "S2", 0);
    expect(b.lists[0].sections.map((s) => s.items.map((i) => i.id))).toEqual([["i1"], ["i2"]]);
    b = moveItem(b, "i1", "S2", 0);
    expect(b.lists[0].sections[1].items.map((i) => i.id)).toEqual(["i1", "i2"]);
    b = addItem(b, { name: "Bread", store: "Target", listId: "L2" }, "t1");
    expect(b.lists[1].sections.map((s) => s.store)).toEqual(["Russian store", "Target"]);
    b = deferLocal(b, "L2", "2026-12-05", "2026-11-25");
    expect(b.lists.map((l) => l.id)).toEqual(["L1"]);
    expect(b.deferred.map((l) => l.id).sort()).toEqual(["L2", "L3"]);
  });
});
