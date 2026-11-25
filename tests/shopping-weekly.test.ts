import { describe, expect, it } from "vitest";
import { flatListTitle, isWeeklyList, nextWeekStart } from "@/modules/family/ui/shopping-board";

describe("weekly shopping lists", () => {
  it("names a one-store list without nesting", () => {
    expect(flatListTitle("Weekly Sam's", "Sam's Club")).toBe("Weekly Sam's Club");
    expect(flatListTitle("Weekly Russian", "Russian store")).toBe("Weekly Russian store");
    expect(flatListTitle("Weekly Sam's Club", "Sam's Club")).toBe("Weekly Sam's Club");
    expect(flatListTitle("Party", "Costco")).toBe("Party · Costco");
  });

  it("spots weekly lists and the next Monday", () => {
    expect(isWeeklyList("Weekly Sam's")).toBe(true);
    expect(isWeeklyList("Biweekly")).toBe(false);
    expect(nextWeekStart("2026-11-25")).toBe("2026-11-30"); // Wednesday → Monday
    expect(nextWeekStart("2026-11-30")).toBe("2026-12-07"); // Monday → next Monday
    expect(nextWeekStart("2026-11-29")).toBe("2026-11-30"); // Sunday → tomorrow
  });
});
