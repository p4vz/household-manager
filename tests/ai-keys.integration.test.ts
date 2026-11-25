import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { coreSettings } from "@/core/db/schema";
import type { Db } from "@/core/db/client";
import { freshDb } from "./helpers/db";

const outbound = vi.fn();
vi.mock("@/core/net/outbound", () => ({ outboundFetch: (...a: unknown[]) => outbound(...a) }));

const keys = await import("@/core/ai/keys");

const CLAUDE = "sk-ant-api03-" + "a".repeat(80) + "WXYZ";
const GEMINI = "AIzaSy" + "b".repeat(33);

let db: Db;

beforeEach(async () => {
  db = await freshDb();
  vi.unstubAllEnvs();
  vi.stubEnv("AUTH_SECRET", "x".repeat(44));
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  outbound.mockReset();
});

describe("AI provider API keys", () => {
  it("masks keys to a prefix and the last four characters", () => {
    expect(keys.maskApiKey(CLAUDE)).toBe("sk-ant-…WXYZ");
    expect(keys.maskApiKey(GEMINI)).toBe(`AIza…${GEMINI.slice(-4)}`);
    expect(keys.maskApiKey("short")).toBe("…");
  });

  it("checks the key shape per provider", () => {
    expect(keys.checkApiKeyShape("anthropic", CLAUDE)).toBeNull();
    expect(keys.checkApiKeyShape("anthropic", GEMINI)).toMatch(/sk-ant-/);
    expect(keys.checkApiKeyShape("gemini", CLAUDE)).toMatch(/not a Gemini key/);
    expect(keys.checkApiKeyShape("gemini", "AIza abc def ghi jkl mno pqr")).toMatch(/spaces/);
  });

  it("stores the key sealed, never in plain text, and returns it only server-side", async () => {
    await keys.saveApiKey("anthropic", `  ${CLAUDE}\n`);
    const [row] = await db.select().from(coreSettings).where(eq(coreSettings.key, "ai.key.anthropic"));
    expect(JSON.stringify(row.value)).not.toContain(CLAUDE);
    expect(JSON.stringify(row.value)).not.toContain("a".repeat(20));
    expect(await keys.getApiKey("anthropic")).toBe(CLAUDE);

    const status = await keys.apiKeyStatus("anthropic");
    expect(status).toMatchObject({ source: "app", hint: "sk-ant-…WXYZ", envAlsoSet: false });
    expect(JSON.stringify(status)).not.toContain(CLAUDE);
    expect(await keys.aiConfigured()).toBe(true);
  });

  it("prefers the saved key, falls back to the environment, and can be removed", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-" + "e".repeat(40) + "ENV1");
    expect(await keys.apiKeyStatus("anthropic")).toMatchObject({ source: "env", hint: "sk-ant-…ENV1" });

    await keys.saveApiKey("anthropic", CLAUDE);
    expect(await keys.getApiKey("anthropic")).toBe(CLAUDE);
    expect(await keys.apiKeyStatus("anthropic")).toMatchObject({ source: "app", envAlsoSet: true });

    await keys.removeApiKey("anthropic");
    expect(await keys.getApiKey("anthropic")).toMatch(/ENV1$/);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await keys.getApiKey("anthropic")).toBeNull();
    expect(await keys.aiConfigured()).toBe(false);
  });

  it("tests a key by listing models with the key in a header, not the URL", async () => {
    outbound.mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await keys.testApiKey("anthropic", CLAUDE)).toEqual({ ok: true, message: "Key works." });
    const [url, init] = outbound.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(url).not.toContain(CLAUDE);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(CLAUDE);

    outbound.mockResolvedValue(new Response("{}", { status: 200 }));
    await keys.testApiKey("gemini", GEMINI);
    const [gUrl, gInit] = outbound.mock.calls[1] as [string, RequestInit];
    expect(gUrl).not.toContain(GEMINI);
    expect((gInit.headers as Record<string, string>)["x-goog-api-key"]).toBe(GEMINI);
  });

  it("reports a rejected key without echoing the provider's body", async () => {
    outbound.mockResolvedValue(new Response(`{"error":"invalid x-api-key ${CLAUDE}"}`, { status: 401 }));
    const r = await keys.testApiKey("anthropic", CLAUDE);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(CLAUDE);
    expect(r.message).toMatch(/rejected/);
  });

  it("tests the saved key when none is typed, and says so when there is none", async () => {
    expect(await keys.testApiKey("gemini")).toMatchObject({ ok: false });
    expect(outbound).not.toHaveBeenCalled();
    await keys.saveApiKey("gemini", GEMINI);
    outbound.mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await keys.testApiKey("gemini")).toMatchObject({ ok: true });
  });
});

describe("Claude subscription token", () => {
  const TOKEN = "sk-ant-oat01-" + "t".repeat(80) + "TOKN";

  it("is checked, stored and masked like the other keys", async () => {
    expect(keys.checkApiKeyShape("claude_subscription", TOKEN)).toBeNull();
    expect(keys.checkApiKeyShape("claude_subscription", CLAUDE)).toMatch(/sk-ant-oat/);
    expect(keys.checkApiKeyShape("anthropic", TOKEN)).toMatch(/subscription token/);
    await keys.saveApiKey("claude_subscription", TOKEN);
    expect(await keys.apiKeyStatus("claude_subscription")).toMatchObject({ source: "app", hint: "sk-ant-…TOKN" });
    expect(await keys.providerConfigured("anthropic")).toBe(true);
    expect(await keys.providerConfigured("gemini")).toBe(false);
  });

  it("falls back to CLAUDE_CODE_OAUTH_TOKEN", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
    expect(await keys.apiKeyStatus("claude_subscription")).toMatchObject({ source: "env" });
    expect(await keys.aiConfigured()).toBe(true);
  });
});
