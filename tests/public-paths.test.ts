import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/core/auth/public-paths";

describe("isPublicPath", () => {
  it("opens only the sign-in page, the Auth.js routes and the PWA files", () => {
    expect(isPublicPath("/signin")).toBe(true);
    expect(isPublicPath("/api/auth/callback/google")).toBe(true);
    for (const p of ["/manifest.webmanifest", "/kiosk.webmanifest", "/sw.js", "/offline.html", "/kiosk-offline.html", "/icons/icon-192.png"]) expect(isPublicPath(p)).toBe(true);
    for (const p of ["/sw.js.map", "/icons", "/manifest.json", "/signin-admin", "/signinx", "/signin/extra", "/", "/finance", "/api/authx", "/api/cron/simplefin-sync"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});
