import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Next reads the matcher statically, so it is checked here from the source:
 * public discovery documents must skip the proxy (no Auth.js cookies on a
 * cacheable response) while every other path still goes through it.
 */
const source = readFileSync("src/proxy.ts", "utf8");
const literal = /matcher:\s*\["([^"]+)"\]/.exec(source)?.[1];
const matcher = new RegExp(`^${JSON.parse(`"${literal}"`)}$`);

describe("proxy matcher", () => {
  it("skips the public discovery documents", () => {
    for (const p of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api/mcp",
      "/.well-known/openid-configuration",
    ]) {
      expect(matcher.test(p), p).toBe(false);
    }
  });

  it("still guards every other path", () => {
    for (const p of ["/", "/finance", "/api/mcp", "/api/oauth/token", "/api/finance/export", "/oauth/authorize", "/.well-knownx", "/x/.well-known/y"]) {
      expect(matcher.test(p), p).toBe(true);
    }
  });
});
