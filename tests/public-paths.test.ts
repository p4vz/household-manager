import { describe, expect, it } from "vitest";
import { isCronPath, isPublicPath } from "@/core/auth/public-paths";

describe("isPublicPath", () => {
  it("allows the sign-in page and the Auth.js routes", () => {
    expect(isPublicPath("/signin")).toBe(true);
    expect(isPublicPath("/api/auth/signin/google")).toBe(true);
    expect(isPublicPath("/api/auth/callback/google")).toBe(true);
  });

  it("does not treat look-alike paths as public", () => {
    for (const p of ["/signinx", "/signin-debug", "/signin/x", "/api/auth", "/api/authx", "/", "/finance", "/api/cron/simplefin-sync"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("recognises cron paths separately", () => {
    expect(isCronPath("/api/cron/card-catalog")).toBe(true);
    expect(isCronPath("/api/cronx")).toBe(false);
  });
});
