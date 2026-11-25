import "server-only";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { legalNamesFromEnv, scrubText } from "@/core/ai/sanitize";
import { db } from "@/core/db/client";
import { corePushSent, corePushSubscriptions } from "@/core/db/core-schema";
import { outboundFetch } from "@/core/net/outbound";
import { open, seal } from "@/core/secrets/secret-box";
import { getSetting, setSetting } from "@/core/settings/store";
import { encryptPayload, generateVapidKeys, vapidAuthorization, type VapidKeys } from "./crypto";
import { DEFAULT_PREFS, NOTIFICATION_TYPES, PUSH_HOSTS, type Member, type NotificationPrefs, type PushMessage } from "./types";

export * from "./types";

/**
 * Phone notifications over Web Push. Each member turns them on per device in
 * Settings; the browser hands us a push-service URL and two keys. Messages
 * are encrypted for that device (RFC 8291), so the push service (Google,
 * Apple, Mozilla) only carries ciphertext. Text is still kept short and
 * scrubbed: no numbers, codes, emails or legal names, since it shows on a
 * lock screen.
 */

// ---------- VAPID keys: from the environment, or made once and kept sealed ----------

const VAPID_KEY = "push.vapid";

export async function vapidKeys(): Promise<VapidKeys> {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
  const stored = (await getSetting(VAPID_KEY)) as { publicKey: string; privateKeySealed: string } | undefined;
  if (stored) {
    try {
      return { publicKey: stored.publicKey, privateKey: open(stored.privateKeySealed) };
    } catch {
      // AUTH_SECRET changed, so the old keys are unreadable. Devices subscribed
      // with them can't be reached any more; they re-subscribe from Settings.
      await db().delete(corePushSubscriptions);
    }
  }
  const keys = generateVapidKeys();
  await setSetting(VAPID_KEY, { publicKey: keys.publicKey, privateKeySealed: seal(keys.privateKey) });
  return keys;
}

function vapidSubject(): string {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  try {
    return new URL(process.env.AUTH_URL ?? "").origin;
  } catch {
    return "https://localhost";
  }
}

// ---------- preferences ----------

export async function getPrefs(member: Member): Promise<NotificationPrefs> {
  const saved = (await getSetting(`push.prefs.${member}`)) as Partial<NotificationPrefs> | undefined;
  return { ...DEFAULT_PREFS, ...saved };
}

export async function setPrefs(member: Member, prefs: NotificationPrefs): Promise<void> {
  const clean = Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, Boolean(prefs[t])])) as NotificationPrefs;
  await setSetting(`push.prefs.${member}`, clean);
}

// ---------- subscriptions ----------

export class PushError extends Error {}

const MAX_DEVICES = 8;

export function checkEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushError("That is not a push address");
  }
  if (url.protocol !== "https:" || !PUSH_HOSTS.includes(url.hostname as (typeof PUSH_HOSTS)[number])) {
    throw new PushError("This browser's push service is not supported. Use Chrome on Android or Safari on iPhone.");
  }
}

export async function saveSubscription(member: Member, sub: { endpoint: string; p256dh: string; auth: string; label: string }) {
  checkEndpoint(sub.endpoint);
  const [{ n }] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(corePushSubscriptions)
    .where(and(eq(corePushSubscriptions.member, member), sql`${corePushSubscriptions.endpoint} <> ${sub.endpoint}`));
  if (Number(n) >= MAX_DEVICES) throw new PushError(`At most ${MAX_DEVICES} devices per person. Remove an old one first.`);
  await db()
    .insert(corePushSubscriptions)
    .values({ member, ...sub })
    .onConflictDoUpdate({ target: corePushSubscriptions.endpoint, set: { member, p256dh: sub.p256dh, auth: sub.auth, label: sub.label, failures: 0 } });
}

export async function listDevices(member: Member) {
  return db()
    .select({ id: corePushSubscriptions.id, label: corePushSubscriptions.label, createdAt: corePushSubscriptions.createdAt, lastOkAt: corePushSubscriptions.lastOkAt, endpoint: corePushSubscriptions.endpoint })
    .from(corePushSubscriptions)
    .where(eq(corePushSubscriptions.member, member))
    .orderBy(corePushSubscriptions.createdAt);
}

export async function removeDevice(member: Member, by: { id?: string; endpoint?: string }) {
  const match = by.id ? eq(corePushSubscriptions.id, by.id) : by.endpoint ? eq(corePushSubscriptions.endpoint, by.endpoint) : null;
  if (!match) return;
  await db().delete(corePushSubscriptions).where(and(eq(corePushSubscriptions.member, member), match));
}

// ---------- sending ----------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What actually leaves the server: short, scrubbed, and a same-origin path only. */
export function pushPayload(msg: PushMessage, legalNames: readonly string[] = legalNamesFromEnv()): string {
  const url = msg.url.startsWith("/") && !msg.url.startsWith("//") ? msg.url : "/";
  return JSON.stringify({
    title: clip(scrubText(msg.title, legalNames), 80),
    body: clip(scrubText(msg.body, legalNames), 180),
    url,
    tag: msg.tag.replace(/[^a-z0-9:-]/gi, "").slice(0, 60),
  });
}

/** Sends to every device of this member. Devices the push service says are gone are removed. */
export async function sendToMember(member: Member, msg: PushMessage, now = new Date()): Promise<{ sent: number; failed: number }> {
  const subs = await db().select().from(corePushSubscriptions).where(eq(corePushSubscriptions.member, member));
  if (subs.length === 0) return { sent: 0, failed: 0 };
  const keys = await vapidKeys();
  const payload = Buffer.from(pushPayload(msg), "utf8");
  let sent = 0;
  let failed = 0;
  for (const s of subs) {
    try {
      checkEndpoint(s.endpoint);
      const res = await outboundFetch(s.endpoint, {
        method: "POST",
        headers: {
          authorization: vapidAuthorization(s.endpoint, keys, vapidSubject(), now),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(24 * 3600),
          urgency: "normal",
        },
        body: new Uint8Array(encryptPayload(payload, { p256dh: s.p256dh, auth: s.auth })),
      });
      if (res.ok) {
        sent++;
        await db().update(corePushSubscriptions).set({ lastOkAt: now, failures: 0 }).where(eq(corePushSubscriptions.id, s.id));
      } else if (res.status === 404 || res.status === 410 || (res.status === 403 && s.failures >= 2)) {
        // Unsubscribed, uninstalled, or keyed to old VAPID keys.
        failed++;
        await db().delete(corePushSubscriptions).where(eq(corePushSubscriptions.id, s.id));
      } else {
        failed++;
        await db().update(corePushSubscriptions).set({ failures: s.failures + 1 }).where(eq(corePushSubscriptions.id, s.id));
      }
    } catch (err) {
      failed++;
      console.error(`[push] send failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { sent, failed };
}

// ---------- once-only bookkeeping ----------

export async function alreadySent(member: Member, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db()
    .select({ key: corePushSent.key })
    .from(corePushSent)
    .where(and(eq(corePushSent.member, member), inArray(corePushSent.key, keys)));
  return new Set(rows.map((r) => r.key));
}

export async function markSent(member: Member, keys: string[], now = new Date()): Promise<void> {
  if (keys.length === 0) return;
  await db()
    .insert(corePushSent)
    .values(keys.map((key) => ({ member, key, sentAt: now })))
    .onConflictDoNothing();
}

export async function pruneSent(now = new Date()): Promise<void> {
  await db().delete(corePushSent).where(lt(corePushSent.sentAt, new Date(now.getTime() - 180 * 86_400_000)));
}

export async function hasDevices(member: Member): Promise<boolean> {
  const [row] = await db().select({ id: corePushSubscriptions.id }).from(corePushSubscriptions).where(eq(corePushSubscriptions.member, member)).limit(1);
  return Boolean(row);
}
