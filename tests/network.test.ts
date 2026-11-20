import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedHosts, checkOutboundUrl, OutboundBlockedError } from "@/core/net/hosts";
import { outboundFetch } from "@/core/net/outbound";
import { isValidCronRequest } from "@/core/net/cron";

describe("outbound host allowlist", () => {
  const hosts = allowedHosts("https://user:pass@bridge.example-sfin.org/simplefin");
  it("allows the provider hosts and the configured SimpleFIN host", () => {
    for (const u of [
      "https://api.anthropic.com/v1/messages",
      "https://generativelanguage.googleapis.com/v1beta/models",
      "https://beta-bridge.simplefin.org/simplefin/create",
      "https://bridge.example-sfin.org/simplefin/accounts",
      "https://oauth2.googleapis.com/token",
    ]) {
      expect(() => checkOutboundUrl(new URL(u), hosts)).not.toThrow();
    }
  });
  it("blocks other hosts, lookalikes and plain http", () => {
    for (const u of [
      "https://evil.example.com/",
      "https://api.anthropic.com.evil.io/",
      "http://api.anthropic.com/",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect(() => checkOutboundUrl(new URL(u), hosts)).toThrow(OutboundBlockedError);
    }
  });
  it("outboundFetch refuses before opening a connection and disables redirects", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await expect(outboundFetch("https://evil.example.com")).rejects.toThrow(OutboundBlockedError);
    expect(spy).not.toHaveBeenCalled();
    await outboundFetch("https://api.anthropic.com/v1/messages", { method: "POST" });
    expect(spy.mock.calls[0][1]).toMatchObject({ redirect: "error", method: "POST" });
  });
  afterEach(() => vi.restoreAllMocks());
});

describe("cron secret", () => {
  const secret = "s".repeat(40);
  const req = (h?: string) => new Request("https://x/api/cron/sync", { headers: h ? { authorization: h } : {} });
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only the exact bearer secret", () => {
    vi.stubEnv("CRON_SECRET", secret);
    expect(isValidCronRequest(req(`Bearer ${secret}`))).toBe(true);
    expect(isValidCronRequest(req(`Bearer ${secret}x`))).toBe(false);
    expect(isValidCronRequest(req(secret))).toBe(false);
    expect(isValidCronRequest(req())).toBe(false);
  });
  it("fails closed when the secret is missing or short", () => {
    vi.stubEnv("CRON_SECRET", "short");
    expect(isValidCronRequest(req("Bearer short"))).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(isValidCronRequest(req("Bearer "))).toBe(false);
  });
});
