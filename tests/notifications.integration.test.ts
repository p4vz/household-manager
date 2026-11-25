import { createECDH } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers/db";
import type { Db } from "@/core/db/client";
import { listDevices, pushPayload, saveSubscription, sendToMember, setPrefs, DEFAULT_PREFS } from "@/core/push/push";
import { dueCandidate, groupMessages } from "@/notify/plan";
import { runNotifications } from "@/notify/run";
import { scheduleTask } from "@/modules/maintenance/api";
import { addReturn } from "@/modules/family/api";

let db: Db;
const sentTo: { url: string; headers: Record<string, string> }[] = [];
let status = 201;

function device(n: number, host = "fcm.googleapis.com") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://${host}/fcm/send/device-${n}`, p256dh: ecdh.getPublicKey("base64url"), auth: Buffer.alloc(16, n).toString("base64url"), label: `Phone ${n}` };
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "x".repeat(40);
  process.env.AUTH_URL = "https://home.example";
  db = await freshDb();
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    sentTo.push({ url: String(input), headers: init.headers as Record<string, string> });
    return new Response(null, { status });
  });
});
afterEach(() => {
  sentTo.length = 0;
  status = 201;
});

describe("reminder rules", () => {
  const item = { id: "t1", title: "Replace HVAC filter", due: "2026-11-28" };
  it("warns ahead, on the day and once overdue", () => {
    expect(dueCandidate("upkeep", item, "2026-11-24", "/m")).toBeNull();
    expect(dueCandidate("upkeep", item, "2026-11-25", "/m")?.line).toBe("Replace HVAC filter, due Sat, Nov 28");
    expect(dueCandidate("upkeep", item, "2026-11-27", "/m")?.line).toBe("Replace HVAC filter, due tomorrow");
    expect(dueCandidate("upkeep", item, "2026-11-28", "/m")?.key).toBe("upkeep:t1:today:2026-11-28");
    expect(dueCandidate("upkeep", item, "2026-12-03", "/m")?.key).toBe("upkeep:t1:overdue:2026-11-28");
    expect(dueCandidate("returns", item, "2026-12-03", "/f")).toBeNull();
    expect(dueCandidate("registrations", item, "2026-11-14", "/m")?.key).toBe("registrations:t1:soon:2026-11-28");
  });

  it("groups one message per type and collapses repeats", () => {
    const c = (type: "suggestions" | "upkeep", key: string, line: string) => ({ type, key, line, url: "/x" });
    const groups = groupMessages(
      [c("suggestions", "a", "A large purchase to review"), c("suggestions", "b", "A large purchase to review"), c("upkeep", "u", "Gutters, due today")],
      { ...DEFAULT_PREFS, upkeep: false },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].message).toMatchObject({ title: "New to review: 2 items", body: "A large purchase to review (2)" });
  });

  it("keeps numbers, emails and outside links off the lock screen", () => {
    const p = JSON.parse(pushPayload({ title: "Card 4111 1111 1111 1111", body: "mail pavel@example.com code K7Q2XZ9", url: "https://evil.example/", tag: "x y" }, ["Jane Q Public"]));
    expect(p.title).not.toMatch(/\d{4}/);
    expect(p.body).not.toContain("@");
    expect(p.body).not.toContain("K7Q2XZ9");
    expect(p.url).toBe("/");
  });
});

describe("phone notifications", () => {
  it("accepts only the known push services", async () => {
    await expect(saveSubscription("user1", device(9, "push.evil.example"))).rejects.toThrow(/not supported/);
    await saveSubscription("user1", device(1));
    await saveSubscription("user2", device(2, "web.push.apple.com"));
    expect((await listDevices("user1")).map((d) => d.label)).toEqual(["Phone 1"]);
  });

  it("sends encrypted, VAPID-signed requests and drops devices that are gone", async () => {
    const r = await sendToMember("user1", { title: "Hi", body: "There", url: "/", tag: "test" });
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(sentTo[0].url).toBe("https://fcm.googleapis.com/fcm/send/device-1");
    expect(sentTo[0].headers["content-encoding"]).toBe("aes128gcm");
    expect(sentTo[0].headers.authorization).toMatch(/^vapid t=.+, k=/);
    await saveSubscription("user1", device(3));
    status = 410;
    await sendToMember("user1", { title: "Hi", body: "There", url: "/", tag: "test" });
    expect(await listDevices("user1")).toEqual([]);
    status = 201;
    await saveSubscription("user1", device(1));
  });

  it("tells both members about shared items and each only about their own accounts, once", async () => {
    const at = new Date("2026-11-25T15:00:00Z"); // 10 AM in New York
    await scheduleTask({ title: "Registration renewal: Honda", dueDate: "2026-12-01", area: "Vehicles" });
    await scheduleTask({ title: "Clean gutters", dueDate: "2026-11-25", area: "Exterior & stormwater" });
    await addReturn({ itemName: "Rain boots", store: "Target", returnDeadline: "2026-11-27" });
    await db.execute(sql`
      insert into finance_accounts (id, bank_name, owner, kind) values
        ('22222222-2222-2222-2222-222222222222', 'Raisa card', 'user2', 'credit'),
        ('33333333-3333-3333-3333-333333333333', 'Joint card', 'joint', 'credit')
    `);
    await db.execute(sql`
      insert into finance_transactions (account_id, source, external_id, posted_date, amount, description, merchant, category) values
        ('22222222-2222-2222-2222-222222222222', 'csv', 'r1', '2026-11-20', -900, 'Jewelry', 'Jewelry Store', 'Shopping'),
        ('33333333-3333-3333-3333-333333333333', 'csv', 'j1', '2026-11-21', -700, 'Sofa', 'Furniture Co', 'Shopping');
    `);

    const first = await runNotifications(at);
    expect(first.status).toBe("ok");
    const byDevice = (n: number) => sentTo.filter((s) => s.url.endsWith(`device-${n}`)).length;
    // Upkeep, registration, return, review: four messages each.
    expect(byDevice(1)).toBe(4);
    expect(byDevice(2)).toBe(4);
    const rows = await db.execute(sql`select member, key from core_push_sent where key like 'review:%' order by member, key`);
    const sent = (Array.isArray(rows) ? rows : (rows as { rows: { member: string; key: string }[] }).rows) as { member: string; key: string }[];
    const jointAndRaisa = sent.filter((r) => r.member === "user2").length;
    const pavel = sent.filter((r) => r.member === "user1").length;
    expect(jointAndRaisa).toBe(2);
    expect(pavel).toBe(1);

    sentTo.length = 0;
    await runNotifications(new Date(at.getTime() + 3_600_000));
    expect(sentTo).toEqual([]);

    // Turned off types are not sent; quiet hours send nothing.
    await setPrefs("user1", { ...DEFAULT_PREFS, upkeep: false });
    await scheduleTask({ title: "Change water filter", dueDate: "2026-11-26", area: "Water filtration" });
    await runNotifications(new Date(at.getTime() + 7_200_000));
    expect(byDevice(1)).toBe(0);
    expect(byDevice(2)).toBe(1);
    sentTo.length = 0;
    expect((await runNotifications(new Date("2026-11-26T04:00:00Z"))).status).toBe("skipped");
  });
});
