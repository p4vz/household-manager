import { NextRequest, type NextFetchEvent } from "next/server";
import { describe, expect, it, vi } from "vitest";

const gated = vi.fn(() => new Response(null, { status: 307, headers: { "set-cookie": "__Host-authjs.csrf-token=x" } }));
vi.mock("@/core/auth/config", () => ({ auth: () => gated }));

const { proxy } = await import("@/proxy");
const event = {} as NextFetchEvent;
const req = (path: string) => new NextRequest(`https://home.example.com${path}`);

describe("proxy and assistant paths", () => {
  it("serves discovery and MCP paths without running Auth.js (no cookies)", async () => {
    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/api/mcp", "/.well-known/openid-configuration", "/api/mcp", "/api/oauth/token"]) {
      const res = await proxy(req(p), event);
      expect(res?.headers.get("set-cookie"), p).toBeNull();
    }
    expect(gated).not.toHaveBeenCalled();
  });

  it("still sends every other path through the session gate", async () => {
    await proxy(req("/finance"), event);
    await proxy(req("/oauth/authorize"), event);
    expect(gated).toHaveBeenCalledTimes(2);
  });
});
