import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy, createNonce } from "@/core/security/csp";

// Stand-in for Auth.js: runs the gate callback with a session for `signedIn`.
let signedIn: string | undefined;
vi.mock("@/core/auth/config", () => ({
  auth:
    (cb: (req: NextRequest & { auth?: unknown }) => Response | undefined) =>
    async (req: NextRequest & { auth?: unknown }) => {
      req.auth = signedIn ? { user: { email: signedIn } } : null;
      return new Response(null, (cb(req) ?? NextResponse.next()) as ResponseInit);
    },
}));

const { proxy } = await import("@/proxy");
const event = {} as NextFetchEvent;
const req = (path: string) => new NextRequest(`https://home.example.com${path}`);

function directive(policy: string, name: string): string {
  return policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
}
const nonceOf = (policy: string | null) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];

describe("content security policy", () => {
  it("allows scripts only by nonce in production", () => {
    const nonce = createNonce();
    const policy = contentSecurityPolicy(nonce, false);
    const scripts = directive(policy, "script-src");
    expect(scripts).toContain(`'nonce-${nonce}'`);
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(directive(policy, "script-src-attr")).toBe("script-src-attr 'none'");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
  });

  it("keeps inline styles (charts) and never puts a nonce on styles", () => {
    // A style nonce would make browsers ignore 'unsafe-inline' and drop Recharts' style attributes.
    const styles = directive(contentSecurityPolicy(createNonce(), false), "style-src");
    expect(styles).toBe("style-src 'self' 'unsafe-inline'");
  });

  it("adds eval and the dev websocket only in development", () => {
    const policy = contentSecurityPolicy(createNonce(), true);
    expect(directive(policy, "script-src")).toContain("'unsafe-eval'");
    expect(directive(policy, "connect-src")).toContain("ws:");
  });

  it("still lets the consent form redirect to the assistants", () => {
    const formAction = directive(contentSecurityPolicy(createNonce(), false), "form-action");
    for (const host of ["https://claude.ai", "https://chatgpt.com", "https://oauth-redirect-sandbox.googleusercontent.com", "https://accounts.google.com"]) {
      expect(formAction).toContain(host);
    }
  });

  it("makes a fresh 128-bit nonce every time and refuses anything else", () => {
    const nonces = new Set(Array.from({ length: 200 }, createNonce));
    expect(nonces.size).toBe(200);
    for (const n of nonces) expect(Buffer.from(n, "base64")).toHaveLength(16);
    expect(() => contentSecurityPolicy("abc'; script-src *")).toThrow();
  });
});

describe("proxy sets the CSP", () => {
  it("gives the page renderer the same nonce the browser enforces", async () => {
    signedIn = undefined;
    const res = await proxy(req("/signin"), event);
    const sent = res.headers.get("content-security-policy");
    // Next.js forwards overridden request headers as x-middleware-request-*.
    const forRenderer = res.headers.get("x-middleware-request-content-security-policy");
    expect(nonceOf(sent)).toBeTruthy();
    expect(forRenderer).toBe(sent);
  });

  it("uses a new nonce on every request", async () => {
    signedIn = undefined;
    const a = nonceOf((await proxy(req("/signin"), event)).headers.get("content-security-policy"));
    const b = nonceOf((await proxy(req("/signin"), event)).headers.get("content-security-policy"));
    expect(a).not.toBe(b);
  });

  it("covers signed-in pages, the consent screen, redirects and assistant paths", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "a@example.com");
    signedIn = "a@example.com";
    for (const p of ["/finance", "/finance/budget", "/oauth/authorize?client_id=x"]) {
      const res = await proxy(req(p), event);
      expect(res.headers.get("x-middleware-request-content-security-policy"), p).toBe(res.headers.get("content-security-policy"));
      expect(nonceOf(res.headers.get("content-security-policy")), p).toBeTruthy();
    }

    signedIn = undefined;
    const redirect = await proxy(req("/finance"), event);
    expect(redirect.status).toBe(307);
    expect(nonceOf(redirect.headers.get("content-security-policy"))).toBeTruthy();

    const mcp = await proxy(req("/api/mcp"), event);
    expect(nonceOf(mcp.headers.get("content-security-policy"))).toBeTruthy();
    expect(mcp.headers.get("set-cookie")).toBeNull();
    vi.unstubAllEnvs();
  });
});
