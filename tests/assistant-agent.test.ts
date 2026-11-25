import { describe, expect, it, vi } from "vitest";

const calls: Record<string, unknown>[] = [];
vi.mock("@/core/ai/claude-code", () => ({
  runClaudeCode: async (opts: Record<string, unknown>) => {
    calls.push(opts);
    return { text: "Here you go.", output: undefined };
  },
}));
vi.mock("@/core/ai/keys", () => ({ getApiKey: async (id: string) => (id === "claude_subscription" ? "sk-ant-oat01-test" : null) }));
vi.mock("@/core/ai/store", () => ({
  getAiSettings: async () => ({ provider: "anthropic", models: { anthropic: { fast: "haiku", flagship: "opus" }, gemini: { fast: "f", flagship: "p" } } }),
}));

const { runAssistantTurn } = await import("@/assistant/agent");
const { RefBook } = await import("@/assistant/conversations");
const { TOOL_NAMES } = await import("@/assistant/tools");

describe("assistant on the subscription", () => {
  it("serves only the household tools in-process, with Claude Code's own tools off, and scrubs the member's text", async () => {
    vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "Pat Example");
    const r = await runAssistantTurn({
      ctx: { email: "one@example.com", owner: "User 1", viewer: "user1", now: new Date("2026-11-25T12:00:00Z") },
      refs: new RefBook({}, 1),
      history: [],
      userText: "Pat Example here, my card is 4111 1111 1111 1111. What did we spend on gas?",
    });
    expect(r.reply).toBe("Here you go.");
    const opts = calls[0] as { inProcessTools: { name: string; allow: string[] }; webSearch?: boolean; prompt: string; system: string };
    expect(opts.inProcessTools.name).toBe("household");
    expect(opts.inProcessTools.allow).toEqual(TOOL_NAMES);
    expect(opts.webSearch).toBeFalsy();
    expect(opts.prompt).not.toContain("4111");
    expect(opts.prompt).not.toContain("Pat");
    expect(opts.system).toMatch(/Never share account numbers/);
  });

  it("has no tool that moves money, deletes accounts or touches settings", () => {
    expect(TOOL_NAMES.join(" ")).not.toMatch(/pay|transfer_money|account_delete|delete_account|setting|key|token|sync|connect/i);
  });
});
