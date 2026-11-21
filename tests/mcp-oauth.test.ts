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
