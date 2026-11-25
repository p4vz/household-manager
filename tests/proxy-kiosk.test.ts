import { NextRequest, type NextFetchEvent } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

/** Every request carries a parent's Google session: the worst case on a kitchen screen. */
vi.mock("@/core/auth/config", () => ({
  auth: (handler: (r: NextRequest & { auth: unknown }) => Response) => (r: NextRequest) =>
    handler(Object.assign(r, { auth: { user: { email: "parent@example.com" } } })),
}));

const { proxy } = await import("@/proxy");
const event = {} as NextFetchEvent;
const TOKEN = "a".repeat(43);

function req(path: string, cookies: Record<string, string>) {
  const r = new NextRequest(`https://home.example.com${path}`);
  for (const [k, v] of Object.entries(cookies)) r.cookies.set(k, v);
  return r;
}
const locked = { hm_kiosk_lock: "1", "__Secure-authjs.session-token": "jwt" };

beforeAll(() => {
  process.env.ALLOWED_EMAILS = "parent@example.com,other@example.com";
});

describe("a browser in kitchen mode stays on the kitchen screen", () => {
  it("sends app pages and sign-in back to /kiosk, even with a parent's session", async () => {
    for (const p of ["/", "/finance", "/settings", "/assistant", "/signin", "/family", "/oauth/authorize"]) {
      const res = await proxy(req(p, locked), event);
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, p).toBe("/kiosk");
    }
  });

  it("refuses the API and Google sign-in", async () => {
    for (const p of ["/api/finance/export", "/api/auth/signin/google", "/api/auth/session"]) {
      expect((await proxy(req(p, locked), event)).status, p).toBe(403);
    }
  });

  it("serves the kiosk, its pairing page and app files, and drops the parent's session", async () => {
    for (const p of ["/kiosk", "/kiosk/pair", "/kiosk.webmanifest", "/version.json", "/icons/icon-192.png"]) {
      const res = await proxy(req(p, { ...locked, hm_kiosk: TOKEN }), event);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.status, p).toBe(200);
      expect(res.headers.get("set-cookie"), p).toMatch(/__Secure-authjs\.session-token=;/);
    }
  });

  it("locks a screen paired before the lock existed on its next visit", async () => {
    const res = await proxy(req("/kiosk", { hm_kiosk: TOKEN, "authjs.session-token": "jwt" }), event);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/hm_kiosk_lock=1; Path=\//);
    expect(set).toMatch(/authjs\.session-token=;/);
  });

  it("leaves a parent's own phone alone", async () => {
    const res = await proxy(req("/finance", { "authjs.session-token": "jwt" }), event);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
