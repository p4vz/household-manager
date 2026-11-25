import { describe, expect, it } from "vitest";

const { suggestCanonical, isCanonical, PARENTS, TAXONOMY, parsePair, formatPair, allChoices } = await import("@/modules/finance/review/taxonomy");
const { DEFAULT_CATEGORIES } = await import("@/modules/finance/ai/categorize");
const { matchCopies, nameSimilarity, tidyAccountName } = await import("@/modules/finance/review/reconcile");

describe("category set", () => {
  it("has the same parents the AI categorizer uses", () => {
    expect([...PARENTS].sort()).toEqual([...DEFAULT_CATEGORIES].sort());
  });

  it("keeps pairs that already fit", () => {
    expect(suggestCanonical({ category: "Food & Dining", subcategory: "Groceries" })).toEqual({ category: "Food & Dining", subcategory: "Groceries" });
    expect(isCanonical({ category: "Home", subcategory: null })).toBe(true);
  });

  it("maps Mint and Simplifi leftovers", () => {
    // After import, "Mint Expense:Amusement" arrives as category "Amusement".
    expect(suggestCanonical({ category: "Amusement", subcategory: null })).toEqual({ category: "Entertainment", subcategory: "Amusement" });
    expect(suggestCanonical({ category: "Groceries", subcategory: null })).toEqual({ category: "Food & Dining", subcategory: "Groceries" });
    expect(suggestCanonical({ category: "Auto & Transport", subcategory: "Gas & Fuel" })).toEqual({ category: "Auto & Transport", subcategory: "Gas & Fuel" });
    expect(suggestCanonical({ category: "Home", subcategory: "Mortgage" })).toEqual({ category: "Home", subcategory: "Mortgage & Rent" });
    expect(suggestCanonical({ category: "Bills and Utilities", subcategory: "Internet" })).toEqual({ category: "Bills & Utilities", subcategory: "Internet" });
    expect(suggestCanonical({ category: "Travel", subcategory: "Hotel" })).toEqual({ category: "Travel", subcategory: "Hotels & Lodging" });
    expect(suggestCanonical({ category: "Transfer for Cash Spending", subcategory: null })).toEqual({ category: "Transfer", subcategory: "Cash & ATM" });
  });

  it("leaves judgment calls for Claude", () => {
    // Utility gas is not fuel.
    expect(suggestCanonical({ category: "Bills & Utilities", subcategory: "Gas" })).toBeNull();
    expect(suggestCanonical({ category: "Shopping", subcategory: "Amazon" })).toBeNull();
    expect(suggestCanonical({ category: "Hockey Club", subcategory: null })).toBeNull();
  });

  it("round-trips the picker format", () => {
    expect(parsePair(formatPair({ category: "Home", subcategory: "Lawn & Garden" }))).toEqual({ category: "Home", subcategory: "Lawn & Garden" });
    expect(parsePair("Home")).toEqual({ category: "Home", subcategory: null });
    expect(parsePair("  ")).toBeNull();
    expect(allChoices()).toContain("Home › Repairs & Maintenance");
    for (const p of PARENTS) expect(new Set(TAXONOMY[p]).size).toBe(TAXONOMY[p].length);
  });
});

describe("reconcile helpers", () => {
  it("pairs each imported row with one bank row of the same amount within 3 days", () => {
    const rows = [
      { id: "b1", source: "simplefin" as const, date: "2026-10-02", amount: -5, merchant: "Cafe" },
      { id: "b2", source: "simplefin" as const, date: "2026-10-10", amount: -80, merchant: "Shell" },
      { id: "c1", source: "csv" as const, date: "2026-10-01", amount: -5, merchant: "CAFE" },
      { id: "c2", source: "csv" as const, date: "2026-10-01", amount: -5, merchant: "CAFE" },
      { id: "c3", source: "csv" as const, date: "2026-10-20", amount: -80, merchant: "Shell" },
    ];
    // c2 is a second real coffee: only one bank row to pair with. c3 is 10 days off.
    expect(matchCopies(rows).map((m) => [m.csvId, m.bankId])).toEqual([["c1", "b1"]]);
  });

  it("tidies names and matches imported accounts to linked ones", () => {
    expect(tidyAccountName("Freedom Visa (Imported)")).toBe("Freedom Visa");
    expect(tidyAccountName("CHASE TOTAL CHECKING -")).toBe("Chase Total Checking");
    expect(tidyAccountName("Sapphire")).toBe("Sapphire");
    expect(nameSimilarity("Freedom Unlimited (Imported)", "Chase Freedom Unlimited")).toBe(1);
    expect(nameSimilarity("Sapphire Preferred", "Joint Checking")).toBe(0);
  });
});
