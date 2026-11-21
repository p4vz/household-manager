import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata,
  grantedScopes,
  isAllowedRedirectUri,
  oauthConfig,
  redirectHosts,
  resourceMatches,
  verifyPkce,
} from "@/core/oauth/policy";
import { forAssistant } from "@/mcp/sanitize";

describe("assistant OAuth policy", () => {
  it("is off unless explicitly enabled with an https AUTH_URL", () => {
    expect(oauthConfig({ AUTH_URL: "https://home.example.com" })).toBeNull();
    expect(oauthConfig({ MCP_ENABLED: "true" })).toBeNull();
    expect(oauthConfig({ MCP_ENABLED: "true", AUTH_URL: "http://home.example.com" })).toBeNull();
    expect(oauthConfig({ MCP_ENABLED: "true", AUTH_URL: "http://localhost:3000", NODE_ENV: "production" })).toBeNull();
    expect(oauthConfig({ MCP_ENABLED: "true", AUTH_URL: "https://home.example.com/api/auth" })).toEqual({
      issuer: "https://home.example.com",
      resource: "https://home.example.com/api/mcp",
    });
  });

  it("only redirects to the assistants' callback hosts or loopback", () => {
    const hosts = redirectHosts({});
    for (const ok of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://oauth-redirect.googleusercontent.com/r/abc",
      "http://localhost:33418/callback",
      "http://127.0.0.1:5000/cb",
    ]) {
      expect(isAllowedRedirectUri(ok, hosts), ok).toBe(true);
    }
    for (const bad of [
      "https://evil.example/cb",
      "https://claude.ai.evil.example/cb",
      "http://claude.ai/cb",
      "https://user:pw@claude.ai/cb",
      "https://claude.ai/cb#frag",
      "https://claude.ai:8443/cb",
      "javascript:alert(1)",
      "http://192.168.1.5/cb",
    ]) {
      expect(isAllowedRedirectUri(bad, hosts), bad).toBe(false);
    }
    expect(isAllowedRedirectUri("https://mcp.example.org/cb", redirectHosts({ MCP_EXTRA_REDIRECT_HOSTS: "mcp.example.org" }))).toBe(true);
  });

  it("accepts Gemini's six callback prefixes and nothing near them", () => {
    const hosts = redirectHosts({});
    for (const host of ["oauth-redirect", "oauth-redirect-sandbox", "oauth-redirect-test"]) {
      for (const prefix of ["r", "a"]) {
        const uri = `https://${host}.googleusercontent.com/${prefix}/user_bound_custom-mcp-abc123`;
        expect(isAllowedRedirectUri(uri, hosts), uri).toBe(true);
      }
    }
    for (const bad of [
      "https://oauth-redirect.googleusercontent.com/",
      "https://oauth-redirect.googleusercontent.com/r/",
      "https://oauth-redirect.googleusercontent.com/x/abc",
      "https://oauth-redirect.googleusercontent.com/rr/abc",
      "https://oauth-redirect.googleusercontent.com/r/../x/abc",
      "http://oauth-redirect.googleusercontent.com/r/abc",
      "https://oauth-redirect.googleusercontent.com:8443/r/abc",
      "https://evil-oauth-redirect.googleusercontent.com/r/abc",
      "https://oauth-redirect.googleusercontent.com.evil.example/r/abc",
      "https://oauth-redirect-prod.googleusercontent.com/r/abc",
      "https://user@oauth-redirect.googleusercontent.com/r/abc",
    ]) {
      expect(isAllowedRedirectUri(bad, hosts), bad).toBe(false);
    }
  });

  it("verifies PKCE S256 and the resource indicator", () => {
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce("b".repeat(43), challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
    const config = { issuer: "https://h.example", resource: "https://h.example/api/mcp" };
    expect(resourceMatches("https://h.example/api/mcp/", config)).toBe(true);
    expect(resourceMatches(null, config)).toBe(true);
    expect(resourceMatches("https://other.example/api/mcp", config)).toBe(false);
  });

  it("grants only the read scope", () => {
    expect(grantedScopes(undefined)).toEqual(["household:read"]);
    expect(grantedScopes("openid email")).toEqual(["household:read"]);
    expect(grantedScopes("household:read admin")).toEqual(["household:read"]);
    expect(grantedScopes("admin")).toBeNull();
  });

  it("advertises PKCE-only public clients with a registration endpoint", () => {
    const m = authorizationServerMetadata({ issuer: "https://h.example", resource: "https://h.example/api/mcp" });
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(m.registration_endpoint).toBe("https://h.example/api/oauth/register");
    expect(m.response_types_supported).toContain("code");
  });
});

describe("assistant output scrub", () => {
  it("removes numbers and legal names but keeps dates", () => {
    const out = forAssistant(
      { card: "Sapphire ****4417", owner: "User 1", note: "Jane Doe card ending in 1234", date: "2026-11-20", at: new Date("2026-11-20T10:00:00Z"), amount: 1234.5 },
      "finance",
      ["Jane Doe"],
    );
    expect(out).toEqual({ card: "Sapphire [redacted]", owner: "User 1", note: "[redacted] card [redacted]", date: "2026-11-20", at: "2026-11-20T10:00:00.000Z", amount: 1234.5 });
  });

  it("keeps years in trip text but not long numbers", () => {
    expect(forAssistant({ name: "Thanksgiving 2026", notes: "Locator 123456789" }, "reference", [])).toEqual({
      name: "Thanksgiving 2026",
      notes: "Locator [redacted]",
    });
  });
});

describe("identifier scrub (the rule)", () => {
  it("removes wallets, IBANs, emails and booking codes but keeps flight numbers and years", async () => {
    const { scrubText, scrubReferenceText } = await import("@/core/ai/sanitize");
    const eth = "0x52908400098527886E0F7030069857D2E4169EE7";
    expect(scrubText(`send to ${eth}`)).toBe("send to [redacted]");
    expect(scrubReferenceText("btc bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe("btc [redacted]");
    expect(scrubReferenceText("old 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2 wallet")).toBe("old [redacted] wallet");
    expect(scrubReferenceText("IBAN DE89 3704 0044 0532 0130 00")).toBe("IBAN [redacted]");
    expect(scrubReferenceText("mail raisa.x@gmail.com")).toBe("mail [redacted]");
    expect(scrubReferenceText("PNR K7Q2XZ on UA1234 in 2026")).toBe("PNR [redacted] on UA1234 in 2026");
  });

  it("drops forbidden keys from assistant answers", () => {
    expect(forAssistant({ card: "Gold", accountNumber: "x", confirmation: "y", email: "z", travelerFullName: "w" }, "finance", [])).toEqual({ card: "Gold" });
  });
});
