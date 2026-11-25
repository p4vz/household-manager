import { describe, expect, it } from "vitest";
import { sanitizePayload, scrubText, toLlmTransaction } from "@/core/ai/sanitize";

const names = ["Alexandra Smith", "Jordan Smith"];

describe("LLM sanitization", () => {
  it("strips card, account and routing numbers in every common shape", () => {
    for (const s of [
      "Card 4111 1111 1111 1111",
      "Acct ****1234",
      "xx-9876 checking",
      "routing 021000021",
      "Visa ending in 4321",
      "4111-1111-1111-1111",
    ]) {
      expect(scrubText(s)).not.toMatch(/\d{4}/);
    }
  });
  it("strips legal names but keeps normal merchant text", () => {
    expect(scrubText("Zelle to Alexandra Smith", names)).toBe("Zelle to Alexandra [redacted]");
    expect(scrubText("Payment from JORDAN", names)).toBe("Payment from JORDAN");
    expect(scrubText("Trader Joe's", names)).toBe("Trader Joe's");
    expect(scrubText("7-Eleven", names)).toBe("7-Eleven");
  });
  it("copies only whitelisted transaction fields", () => {
    const out = toLlmTransaction(
      {
        date: "2026-11-02T10:00:00Z",
        merchant: "AMAZON MKTPL*1234567",
        category: "Shopping",
        amount: -42.5,
        cardName: "Alexandra's Sapphire",
        accountName: "Chase Sapphire ****9999",
        owner: "User 1",
        accountNumber: "123456789012",
        routingNumber: "021000021",
        raw: { payee: "Alexandra Smith" },
      },
      names,
    );
    expect(Object.keys(out).sort()).toEqual(
      ["accountName", "amount", "cardName", "category", "date", "merchant", "owner"].sort(),
    );
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/\d{4,}(?!-\d{2}-\d{2})/);
    expect(json).not.toMatch(/Smith/i);
    expect(out.date).toBe("2026-11-02");
    expect(out.amount).toBe(-42.5);
  });
  it("keeps ISO dates and numbers intact in sealed payloads", () => {
    const p = sanitizePayload({ month: "2026-10", rows: [{ date: "2026-10-05", amount: 1234.5, note: "acct 55556666" }] });
    expect(p.month).toBe("2026-10");
    expect(p.rows[0].date).toBe("2026-10-05");
    expect(p.rows[0].amount).toBe(1234.5);
    expect(p.rows[0].note).toBe("acct [redacted]");
  });
});

describe("household names (Pavel, 2026-11-25)", () => {
  it("keeps first names and nicknames, removes surnames and so full names", async () => {
    const { householdNicknames } = await import("@/core/ai/sanitize");
    const entries = ["Daniel Smith=Danya", "Raisa Smith=Raya", "Elana Smith", "Pavel Smith=Pavel"];
    expect(scrubText("Danya and Daniel, Raya and Raisa, Elana, Pavel Smith", entries)).toBe("Danya and Daniel, Raya and Raisa, Elana, Pavel [redacted]");
    expect(scrubText("SMITH DANIEL", entries)).toBe("[redacted] DANIEL");
    expect(householdNicknames(entries)).toEqual(["Danya (Daniel)", "Raya (Raisa)", "Pavel"]);
  });
});
