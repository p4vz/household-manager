import { describe, expect, it } from "vitest";
import { THE_RULE } from "@/core/oauth/permissions";
import { assistantName } from "@/core/oauth/policy";

describe("assistantName", () => {
  it("names the known assistants by their redirect host", () => {
    expect(assistantName("https://claude.ai/api/mcp/auth_callback", "x")).toBe("Claude");
    expect(assistantName("https://claude.com/api/mcp/auth_callback", "x")).toBe("Claude");
    expect(assistantName("https://chatgpt.com/connector_platform_oauth_redirect", "x")).toBe("ChatGPT");
    expect(assistantName("https://oauth-redirect.googleusercontent.com/r/project-1", "x")).toBe("Gemini");
    expect(assistantName("https://oauth-redirect-sandbox.googleusercontent.com/a/abc", "x")).toBe("Gemini");
  });

  it("does not trust a registered name or a look-alike host", () => {
    expect(assistantName("https://evil.example/cb", "Claude")).toBe("Claude"); // registered name kept, not upgraded
    expect(assistantName("https://claude.ai.evil.example/cb", "Some app")).toBe("Some app");
    expect(assistantName("http://claude.ai/cb", "Some app")).toBe("Some app");
    expect(assistantName("https://oauth-redirect.googleusercontent.com/x/1", "Some app")).toBe("Some app");
    expect(assistantName("http://127.0.0.1:3000/cb", "Desktop")).toBe("Desktop");
    expect(assistantName(undefined, "Unnamed assistant")).toBe("Unnamed assistant");
  });
});

describe("THE_RULE", () => {
  it("names Pavel and Raisa as the purchase approvers", () => {
    expect(THE_RULE.join(" ")).toContain("approved by Pavel and/or Raisa");
  });
});

describe("memberDisplayName", () => {
  it("shows first names on screen and passes other labels through", async () => {
    const { memberDisplayName } = await import("@/core/auth/display-name");
    expect(memberDisplayName("User 1")).toBe("Pavel");
    expect(memberDisplayName("User 2")).toBe("Raisa");
    expect(memberDisplayName("Removed member")).toBe("Removed member");
  });
});
