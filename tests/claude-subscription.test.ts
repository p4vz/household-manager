import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const getApiKey = vi.fn();
vi.mock("@/core/ai/keys", () => ({ getApiKey: (k: string) => getApiKey(k) }));
vi.mock("@/core/ai/store", () => ({
  getAiSettings: async () => ({
    provider: "anthropic",
    models: { anthropic: { fast: "claude-haiku-5-5", flagship: "claude-opus-5-5" }, gemini: { fast: "g", flagship: "g" } },
  }),
}));
const runClaudeCodeStructured = vi.fn();
vi.mock("@/core/ai/claude-code", () => ({ runClaudeCodeStructured: (o: unknown) => runClaudeCodeStructured(o) }));
const generateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (o: unknown) => generateText(o),
  isStepCount: () => undefined,
  Output: { object: () => undefined },
}));
vi.mock("@/core/ai/provider", () => ({ languageModel: async () => "api-model", webSearchTools: async () => ({}) }));

const { runStructured } = await import("@/core/ai/run");
const { childEnv } = await vi.importActual<typeof import("@/core/ai/claude-code")>("@/core/ai/claude-code");

const schema = z.object({ ok: z.boolean() });
const call = () =>
  runStructured({ tier: "fast", system: "s", task: "t", payload: { x: 1 } as never, schema });

beforeEach(() => {
  getApiKey.mockReset();
  runClaudeCodeStructured.mockReset();
  generateText.mockReset();
});

describe("Claude routing", () => {
  it("uses the subscription when a token is saved", async () => {
    getApiKey.mockImplementation(async (k: string) => (k === "claude_subscription" ? "sk-ant-oat01-x" : null));
    runClaudeCodeStructured.mockResolvedValue({ ok: true });
    expect(await call()).toEqual({ ok: true });
    expect(runClaudeCodeStructured).toHaveBeenCalledWith(expect.objectContaining({ token: "sk-ant-oat01-x", model: "claude-haiku-5-5" }));
    expect(generateText).not.toHaveBeenCalled();
  });

  it("falls back to the API key when the subscription call fails", async () => {
    getApiKey.mockImplementation(async (k: string) => (k === "claude_subscription" ? "tok" : "sk-ant-api03-key"));
    runClaudeCodeStructured.mockRejectedValue(new Error("usage limit"));
    generateText.mockResolvedValue({ output: { ok: false } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await call()).toEqual({ ok: false });
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("surfaces the subscription error when there is no API key", async () => {
    getApiKey.mockImplementation(async (k: string) => (k === "claude_subscription" ? "tok" : null));
    runClaudeCodeStructured.mockRejectedValue(new Error("usage limit"));
    await expect(call()).rejects.toThrow("usage limit");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("uses the API directly with no token", async () => {
    getApiKey.mockResolvedValue(null);
    generateText.mockResolvedValue({ output: { ok: true } });
    await call();
    expect(runClaudeCodeStructured).not.toHaveBeenCalled();
  });
});

describe("Claude Code child environment", () => {
  it("passes the token but none of the app's secrets", () => {
    vi.stubEnv("DATABASE_URL", "postgres://secret");
    vi.stubEnv("AUTH_SECRET", "s".repeat(40));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-should-not-pass");
    const env = childEnv("sk-ant-oat01-tok", "/tmp/h");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-tok");
    expect(env.HOME).toBe("/tmp/h");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("AUTH_SECRET");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    vi.unstubAllEnvs();
  });
});
