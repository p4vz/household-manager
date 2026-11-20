import { describe, expect, it } from "vitest";
import { isAllowedEmail, ownerLabelFor, parseAllowlist } from "@/core/auth/allowlist";

const list = parseAllowlist(" Me@Gmail.com , partner@gmail.com ");

describe("email allowlist", () => {
  it("matches exactly, case-insensitively", () => {
    expect(isAllowedEmail("me@gmail.com", list)).toBe(true);
    expect(isAllowedEmail("PARTNER@gmail.com", list)).toBe(true);
  });
  it("rejects lookalikes, subaddresses, other domains and empties", () => {
    for (const e of ["me+x@gmail.com", "me@gmail.com.evil.io", "xme@gmail.com", "me@googlemail.com", "", undefined, null, 42]) {
      expect(isAllowedEmail(e, list)).toBe(false);
    }
  });
  it("rejects everyone when the allowlist is empty", () => {
    expect(isAllowedEmail("me@gmail.com", parseAllowlist(""))).toBe(false);
    expect(isAllowedEmail("me@gmail.com", parseAllowlist(undefined))).toBe(false);
  });
  it("labels owners by position, never by name", () => {
    expect(ownerLabelFor("me@gmail.com", list)).toBe("User 1");
    expect(ownerLabelFor("partner@gmail.com", list)).toBe("User 2");
    expect(ownerLabelFor("other@gmail.com", list)).toBeNull();
  });
});
