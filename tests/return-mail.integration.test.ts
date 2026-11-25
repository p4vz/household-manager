import { beforeEach, describe, expect, it, vi } from "vitest";
import { familyMailboxes, familyReturnSuggestions } from "@/core/db/schema";
import type { Db } from "@/core/db/client";
import { freshDb } from "./helpers/db";

/** A fake Google: token endpoint, revoke, and a Gmail mailbox with three matching emails. */
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const calls: URL[] = [];
const gmailMessages: Record<string, { subject: string; from: string; body: string }> = {
  m1: { subject: "Your Target return label", from: '"Target" <returns@target.com>', body: "Return for Blue lamp. Order #902-1234567. Drop off at UPS by 2026-12-10. Questions: help@target.com" },
  m2: { subject: "Refund issued", from: '"Old Navy" <orders@oldnavy.com>', body: "We received your return of Kids jeans. Refund to Visa ending in 4242." },
  m3: { subject: "Returns are easy this holiday", from: "promo@shop.example", body: "Big sale!" },
};
let revoked = 0;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("@/core/net/outbound", () => ({
  outboundFetch: async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      revoked += 1;
      return json({});
    }
    if (url.href === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "authorization_code") {
        return json({ access_token: "at", refresh_token: "rt-secret", scope: "https://www.googleapis.com/auth/gmail.readonly", expires_in: 3600 });
      }
      return json({ access_token: "at2", expires_in: 3600 });
    }
    if (url.pathname === "/gmail/v1/users/me/profile") return json({ emailAddress: "Shopper.Spare@gmail.com" });
    if (url.pathname === "/gmail/v1/users/me/messages") return json({ messages: Object.keys(gmailMessages).map((id) => ({ id })) });
    const m = /\/messages\/([^/]+)$/.exec(url.pathname);
    if (m && gmailMessages[m[1]]) {
      const g = gmailMessages[m[1]];
      return json({
        id: m[1],
        internalDate: String(Date.parse("2026-11-24T15:00:00Z")),
        payload: { headers: [{ name: "Subject", value: g.subject }, { name: "From", value: g.from }], mimeType: "text/plain", body: { data: b64(g.body) } },
      });
    }
    return json({}, 404);
  },
}));

const runStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({ runStructured: (...a: unknown[]) => runStructured(...a) }));

const api = await import("@/modules/family/api");

let db: Db;

beforeEach(async () => {
  db = await freshDb();
  calls.length = 0;
  revoked = 0;
  vi.stubEnv("AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("AUTH_GOOGLE_ID", "client-id");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "client-secret");
  vi.stubEnv("HOUSEHOLD_TIMEZONE", "America/New_York");
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "");
  runStructured.mockReset();
  runStructured.mockImplementation(async (opts: { payload: { subject: string } }) => {
    const subject = opts.payload.subject ?? "";
    if (subject.includes("label")) return { isReturn: true, kind: "label", store: "Target", itemName: "Blue lamp", returnDeadline: "2026-12-10", howToReturn: "Drop off at UPS" };
    if (subject.includes("Refund")) return { isReturn: true, kind: "refund", store: "Old Navy", itemName: "Kids jeans", returnDeadline: null, howToReturn: null };
    return { isReturn: false, kind: null, store: null, itemName: null, returnDeadline: null, howToReturn: null };
  });
});

async function connect(member: "user1" | "user2") {
  const url = new URL(await api.startMailConnect(member, "https://home.example.com"));
  const state = url.searchParams.get("state")!;
  await api.finishMailConnect({ member, state, code: "code", origin: "https://home.example.com" });
  const [box] = await db.select().from(familyMailboxes);
  return box;
}

describe("connecting a Gmail mailbox", () => {
  it("asks Google for read-only Gmail with PKCE and the registered redirect", async () => {
    const url = new URL(await api.startMailConnect("user1", "https://home.example.com"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("redirect_uri")).toBe("https://home.example.com/settings/email/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("refuses a state started by the other member, and a reused state", async () => {
    const url = new URL(await api.startMailConnect("user1", "https://home.example.com"));
    const state = url.searchParams.get("state")!;
    await expect(api.finishMailConnect({ member: "user2", state, code: "c", origin: "https://home.example.com" })).rejects.toThrow(/expired/);
    await expect(api.finishMailConnect({ member: "user1", state, code: "c", origin: "https://home.example.com" })).rejects.toThrow(/expired/);
  });

  it("stores the address and refresh token sealed, and shows the mailbox only to its member", async () => {
    const box = await connect("user1");
    expect(box.addressSealed).not.toContain("gmail");
    expect(box.refreshTokenSealed).not.toContain("rt-secret");
    expect((await api.listMailboxes("user1")).map((m) => m.address)).toEqual(["shopper.spare@gmail.com"]);
    expect(await api.listMailboxes("user2")).toEqual([]);
    await expect(api.disconnectMailbox("user2", box.id)).rejects.toThrow();
  });
});

describe("scanning for return emails", () => {
  it("files suggestions for the mailbox's member only and reads each email once", async () => {
    await api.addReturn({ itemName: "Kids jeans", store: "Old Navy" });
    await connect("user1");
    const res = await api.scanMemberMailboxes("user1");
    expect(res[0]).toMatchObject({ ok: true, read: 3, found: 2 });

    const list = calls.find((u) => u.pathname === "/gmail/v1/users/me/messages")!;
    expect(list.searchParams.get("includeSpamTrash")).toBe("true");
    expect(list.searchParams.get("q")).toContain("-in:trash");

    const mine = await api.listReturnSuggestions("user1");
    expect(mine.map((s) => [s.kind, s.store, s.itemName, s.returnDeadline])).toEqual(
      expect.arrayContaining([
        ["label", "Target", "Blue lamp", "2026-12-10"],
        ["refund", "Old Navy", "Kids jeans", null],
      ]),
    );
    expect(mine.find((s) => s.kind === "refund")?.match?.itemName).toBe("Kids jeans");
    expect(mine[0].emailUrl).toMatch(/^https:\/\/mail\.google\.com\/mail\/u\/\?authuser=shopper\.spare%40gmail\.com#all\/m\d$/);
    expect(await api.listReturnSuggestions("user2")).toEqual([]);

    // Nothing identifying went to the AI.
    const sent = JSON.stringify(runStructured.mock.calls.map((c) => c[0].payload));
    for (const leaked of ["1234567", "4242", "help@target.com", "returns@target.com", "shopper.spare"]) expect(sent).not.toContain(leaked);
    expect(sent).toContain("by December 10, 2026");
    expect(sent).toContain('"received":"November 24, 2026"');

    // Nothing of the email body is stored.
    const rows = await db.select().from(familyReturnSuggestions);
    expect(JSON.stringify(rows)).not.toContain("Questions");
    expect(rows).toHaveLength(3);

    runStructured.mockClear();
    await api.scanMemberMailboxes("user1");
    expect(runStructured).not.toHaveBeenCalled();
  });

  it("skips Spam when the member turns it off, and only scans when due", async () => {
    const box = await connect("user1");
    await api.setMailboxSpam("user1", box.id, false);
    const now = new Date();
    expect(await api.scanDueMailboxes(now)).toMatchObject({ scanned: 1 });
    const list = calls.filter((u) => u.pathname === "/gmail/v1/users/me/messages");
    expect(list.at(-1)!.searchParams.get("includeSpamTrash")).toBe("false");
    expect(await api.scanDueMailboxes(new Date(now.getTime() + 60_000))).toMatchObject({ scanned: 0 });
  });

  it("does not suggest a return already on the list, and accepting or dismissing clears suggestions", async () => {
    await api.addReturn({ itemName: "Blue lamp", store: "Target" });
    await connect("user1");
    await api.scanMemberMailboxes("user1");
    const mine = await api.listReturnSuggestions("user1");
    expect(mine.map((s) => s.store)).toEqual([]); // label is a duplicate; refund has no Old Navy return to match
    const [dupe] = (await db.select().from(familyReturnSuggestions)).filter((r) => r.store === "Target");
    expect(dupe.status).toBe("duplicate");
  });

  it("records a failed scan without losing emails, and disconnect revokes and forgets everything", async () => {
    runStructured.mockRejectedValueOnce(new Error("AI down"));
    const box = await connect("user1");
    const [res] = await api.scanMemberMailboxes("user1");
    expect(res.ok).toBe(false);
    expect((await api.listMailboxes("user1"))[0].lastScanOk).toBe(false);
    expect(await db.select().from(familyReturnSuggestions)).toHaveLength(0);

    await api.scanMemberMailboxes("user1");
    const [s] = await api.listReturnSuggestions("user1");
    await expect(api.markSuggestion("user2", s.id, "dismissed")).rejects.toThrow();
    await api.markSuggestion("user1", s.id, "dismissed");
    expect(await api.listReturnSuggestions("user1")).toEqual([]);

    await api.disconnectMailbox("user1", box.id);
    expect(revoked).toBe(1);
    expect(await db.select().from(familyReturnSuggestions)).toHaveLength(0);
    expect(await db.select().from(familyMailboxes)).toHaveLength(0);
  });
});
