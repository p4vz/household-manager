import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/core/auth/public-paths";

describe("isPublicPath", () => {
  it("opens only the sign-in page and the Auth.js routes", () => {
    expect(isPublicPath("/signin")).toBe(true);
    expect(isPublicPath("/api/auth/callback/google")).toBe(true);
    for (const p of ["/signin-admin", "/signinx", "/signin/extra", "/", "/finance", "/api/authx", "/api/cron/simplefin-sync"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});
