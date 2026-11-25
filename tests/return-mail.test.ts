import { describe, expect, it } from "vitest";
import { htmlToText, messageText, returnSearchQuery, sameStore, scrubMailText, senderName, similarItem, type GmailMessage } from "@/modules/family/mail-text";
import { cleanExtracted } from "@/modules/family/return-extract";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("return email search", () => {
  it("asks only for return-related mail since the given time, never trash", () => {
    const q = returnSearchQuery(new Date("2026-11-01T00:00:00Z"));
    expect(q).toContain(`after:${Date.parse("2026-11-01T00:00:00Z") / 1000}`);
    expect(q).toContain("-in:trash");
    expect(q).toContain("subject:refund");
    expect(q).toContain('"return label"');
  });
});

describe("message text", () => {
  it("prefers text/plain and falls back to visible HTML text", () => {
    const plain: GmailMessage = {
      id: "m1",
      payload: { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<b>html</b>") } }, { mimeType: "text/plain", body: { data: b64("Return by Dec 20") } }] },
    };
    expect(messageText(plain)).toBe("Return by Dec 20");
    const html: GmailMessage = {
      id: "m2",
      payload: { mimeType: "text/html", body: { data: b64("<style>.x{}</style><p>Your return&nbsp;label</p><a href='https://x.example/t?id=1'>Print</a>") } },
    };
    expect(messageText(html)).toBe("Your return label\nPrint");
  });

  it("skips attachments and caps the length", () => {
    const msg: GmailMessage = {
      id: "m3",
      payload: { parts: [{ mimeType: "text/plain", filename: "label.txt", body: { data: b64("attached") } }, { mimeType: "text/plain", body: { data: b64("x".repeat(9000)) } }] },
    };
    expect(messageText(msg)).toHaveLength(4000);
    expect(htmlToText("a &amp; b &#39;c&#39;")).toBe("a & b 'c'");
  });

  it("names the sender by display name or mail domain", () => {
    expect(senderName('"Old Navy" <orders@oldnavy.com>')).toBe("Old Navy");
    expect(senderName("returns@email.target.com")).toBe("Target");
  });
});

describe("scrubbing before the AI", () => {
  it("removes order, tracking and card numbers, links, emails and phone numbers but keeps dates", () => {
    const text = [
      "Order #112-4455667-8899001 for Pavel Example",
      "Tracking number: 1Z999AA10123456784",
      "Order number W123456789",
      "Paid with Visa ending in 4242",
      "Return by 2026-12-20 or December 20, 2026",
      "Questions? help@shop.example or 1-800-555-0199",
      "Print: https://shop.example/returns/label?token=abc123",
      "Drop off at UPS, RMA: R4X9921",
    ].join("\n");
    const out = scrubMailText(text, ["Pavel Example"]);
    for (const leaked of ["4455667", "1Z999AA", "W123456789", "4242", "help@shop", "555-0199", "https://", "token", "R4X9921", "Pavel", "Example"]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("Return by December 20, 2026 or December 20, 2026");
    expect(out).toContain("Drop off at UPS");
  });
});

describe("matching", () => {
  it("compares stores and items loosely", () => {
    expect(sameStore("Target", "target.com")).toBe(true);
    expect(sameStore("Old Navy", "Gap")).toBe(false);
    expect(similarItem("Blue running shoes", "Running shoes, size 9")).toBe(true);
    expect(similarItem("Lamp", "Running shoes")).toBe(false);
  });
});

describe("extracted fields", () => {
  it("drops identifiers the model echoed and rejects malformed dates", () => {
    const out = cleanExtracted({
      isReturn: true,
      kind: "label",
      store: "Target",
      itemName: "Order 123456789",
      returnDeadline: "Dec 20",
      howToReturn: "QR code [redacted] at UPS",
    });
    expect(out.itemName).toBeNull();
    expect(out.returnDeadline).toBeNull();
    expect(out.howToReturn).toBe("QR code at UPS");
    expect(out.store).toBe("Target");
  });
});
