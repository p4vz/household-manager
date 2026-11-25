import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/core/db/client";
import { outboundFetch } from "@/core/net/outbound";
import { open, seal } from "@/core/secrets/secret-box";
import { householdTimeZone } from "@/core/time/zoned";
import { householdToday } from "./time";
import { FIRST_SCAN_DAYS, header, messageText, returnSearchQuery, sameStore, senderName, similarItem, type GmailMessage } from "./mail-text";
import { extractReturn } from "./return-extract";
import { familyMailboxes, familyMailConnectStates, familyPurchaseReturns, familyReturnSuggestions } from "./schema";

/**
 * Return emails. Each member connects their own Gmail mailboxes with a
 * read-only Google sign-in (gmail.readonly). The app searches only for
 * return-related mail (mail-text.ts), reads each match once, keeps the
 * extracted fields and Gmail's message id, and drops the email.
 *
 * Privacy (Pavel, 2026-11-25): a mailbox and what was found in it are seen
 * only by the member who connected it. A found return reaches the shared
 * list (kiosk, the other member) only when that member adds it.
 *
 * Hosts: accounts.google.com (browser redirect), oauth2.googleapis.com
 * (token and revoke) and gmail.googleapis.com, all on the allowlist.
 */
export type Member = "user1" | "user2";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const STATE_TTL_MS = 10 * 60_000;
/** Most emails read per mailbox per scan; the rest wait for the next scan. */
const MAX_MESSAGES_PER_SCAN = 25;
/** Scheduled scans run at most this often per mailbox. */
export const SCAN_INTERVAL_MS = 3 * 60 * 60_000;

export class MailConnectError extends Error {}

function clientId() {
  return process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || process.env.AUTH_GOOGLE_ID || "";
}
function clientSecret() {
  return process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET || "";
}

const addressHash = (address: string) => createHash("sha256").update(address.trim().toLowerCase()).digest("hex");

/** The page Google sends the member back to. Must be listed on the OAuth client. */
export function mailRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, "")}/settings/email/callback`;
}

/** Step 1: a Google sign-in URL for a read-only Gmail grant, tied to this member by a one-time state. */
export async function startMailConnect(member: Member, origin: string, now = new Date()): Promise<string> {
  if (!clientId() || !clientSecret()) throw new MailConnectError("Google sign-in is not configured");
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await db().delete(familyMailConnectStates).where(lt(familyMailConnectStates.expiresAt, now));
  await db()
    .insert(familyMailConnectStates)
    .values({ state, member, verifier, expiresAt: new Date(now.getTime() + STATE_TTL_MS) });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: mailRedirectUri(origin),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Step 2: trade the code for a refresh token and save the mailbox for this member. */
export async function finishMailConnect(input: { member: Member; state: string; code: string; origin: string; now?: Date }): Promise<{ address: string }> {
  const now = input.now ?? new Date();
  const [pending] = await db()
    .delete(familyMailConnectStates)
    .where(eq(familyMailConnectStates.state, input.state))
    .returning();
  if (!pending || pending.expiresAt < now || pending.member !== input.member) {
    throw new MailConnectError("That sign-in link expired. Try Connect Gmail again.");
  }
  const res = await outboundFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: pending.verifier,
      redirect_uri: mailRedirectUri(input.origin),
      client_id: clientId(),
      client_secret: clientSecret(),
    }),
  });
  if (!res.ok) throw new MailConnectError(`Google refused the sign-in (HTTP ${res.status})`);
  const token = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string };
  if (!token.access_token || !token.refresh_token) throw new MailConnectError("Google did not return offline access. Try again.");
  if (!token.scope?.split(" ").includes(SCOPE)) throw new MailConnectError("Gmail read access was not granted. Tick the Gmail box on Google's screen.");

  const profile = await outboundFetch(`${GMAIL}/profile`, { headers: { authorization: `Bearer ${token.access_token}` } });
  if (!profile.ok) throw new MailConnectError(`Could not read the mailbox address (HTTP ${profile.status}). Is the Gmail API turned on?`);
  const address = ((await profile.json()) as { emailAddress?: string }).emailAddress?.toLowerCase();
  if (!address) throw new MailConnectError("Google did not say which mailbox this is");

  await db()
    .insert(familyMailboxes)
    .values({ member: input.member, addressSealed: seal(address), addressHash: addressHash(address), refreshTokenSealed: seal(token.refresh_token) })
    .onConflictDoUpdate({
      target: [familyMailboxes.member, familyMailboxes.addressHash],
      set: { refreshTokenSealed: seal(token.refresh_token), lastScanOk: null, lastScanMessage: null },
    });
  return { address };
}

export type MailboxView = {
  id: string;
  address: string;
  includeSpam: boolean;
  lastScanAt: string | null;
  lastScanOk: boolean | null;
  lastScanMessage: string | null;
};

/** This member's mailboxes, for their own Settings page only. */
export async function listMailboxes(member: Member): Promise<MailboxView[]> {
  const rows = await db().select().from(familyMailboxes).where(eq(familyMailboxes.member, member)).orderBy(asc(familyMailboxes.createdAt));
  return rows.map((r) => ({
    id: r.id,
    address: safeOpen(r.addressSealed) ?? "(unreadable: reconnect)",
    includeSpam: r.includeSpam,
    lastScanAt: r.lastScanAt?.toISOString() ?? null,
    lastScanOk: r.lastScanOk,
    lastScanMessage: r.lastScanMessage,
  }));
}

function safeOpen(sealed: string): string | null {
  try {
    return open(sealed);
  } catch {
    return null;
  }
}

async function ownMailbox(member: Member, id: string) {
  const [row] = await db()
    .select()
    .from(familyMailboxes)
    .where(and(eq(familyMailboxes.id, id), eq(familyMailboxes.member, member)));
  if (!row) throw new MailConnectError("That mailbox is not connected");
  return row;
}

export async function setMailboxSpam(member: Member, id: string, includeSpam: boolean) {
  await ownMailbox(member, id);
  await db().update(familyMailboxes).set({ includeSpam }).where(eq(familyMailboxes.id, id));
}

/** Revoke Google's grant (best effort) and forget the mailbox and everything found in it. */
export async function disconnectMailbox(member: Member, id: string) {
  const row = await ownMailbox(member, id);
  const refresh = safeOpen(row.refreshTokenSealed);
  if (refresh) {
    await outboundFetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh }),
    }).catch(() => undefined);
  }
  await db().delete(familyMailboxes).where(eq(familyMailboxes.id, id));
}

// ------------------------------------------------------------------ scan ----

async function accessToken(refreshSealed: string): Promise<string> {
  const refresh = safeOpen(refreshSealed);
  if (!refresh) throw new Error("Saved sign-in is unreadable; reconnect this mailbox");
  const res = await outboundFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId(), client_secret: clientSecret() }),
  });
  if (res.status === 400 || res.status === 401) throw new Error("Google sign-in expired or was removed; reconnect this mailbox");
  if (!res.ok) throw new Error(`Google token request failed (HTTP ${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Google token response had no access token");
  return json.access_token;
}

async function gmail<T>(token: string, path: string, query: Record<string, string | string[]> = {}): Promise<T> {
  const url = new URL(`${GMAIL}${path}`);
  for (const [k, v] of Object.entries(query)) for (const one of [v].flat()) url.searchParams.append(k, one);
  const res = await outboundFetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 403) throw new Error("Gmail refused access (is the Gmail API turned on for the Google project?)");
  if (!res.ok) throw new Error(`Gmail request failed (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export type ScanResult = { mailboxId: string; ok: boolean; read: number; found: number; message: string | null };

/** Read new return emails in one mailbox and file what they say as suggestions for its member. */
export async function scanMailbox(id: string, now = new Date()): Promise<ScanResult> {
  const [box] = await db().select().from(familyMailboxes).where(eq(familyMailboxes.id, id));
  if (!box) return { mailboxId: id, ok: false, read: 0, found: 0, message: "Mailbox not found" };
  let read = 0;
  let found = 0;
  try {
    const token = await accessToken(box.refreshTokenSealed);
    // Look back a day past the last scan so mail delivered late is not missed; each message is read once anyway.
    const since = box.lastScanAt ? new Date(box.lastScanAt.getTime() - 24 * 3600_000) : new Date(now.getTime() - FIRST_SCAN_DAYS * 24 * 3600_000);
    const list = await gmail<{ messages?: { id: string }[] }>(token, "/messages", {
      q: returnSearchQuery(since),
      maxResults: "50",
      includeSpamTrash: box.includeSpam ? "true" : "false",
    });
    const ids = (list.messages ?? []).map((m) => m.id);
    const seen = ids.length
      ? new Set(
          (
            await db()
              .select({ messageId: familyReturnSuggestions.messageId })
              .from(familyReturnSuggestions)
              .where(and(eq(familyReturnSuggestions.mailboxId, id), inArray(familyReturnSuggestions.messageId, ids)))
          ).map((r) => r.messageId),
        )
      : new Set<string>();
    const fresh = ids.filter((m) => !seen.has(m)).slice(0, MAX_MESSAGES_PER_SCAN);

    for (const messageId of fresh) {
      const msg = await gmail<GmailMessage>(token, `/messages/${encodeURIComponent(messageId)}`, { format: "full" });
      read += 1;
      const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)) : now;
      const extracted = await extractReturn({
        text: messageText(msg),
        subject: header(msg, "Subject"),
        sender: senderName(header(msg, "From")),
        receivedDate: householdToday(receivedAt, householdTimeZone()),
      });
      const row = await fileSuggestion({ mailboxId: id, member: box.member, messageId, receivedAt, extracted });
      if (row === "new") found += 1;
    }
    const more = ids.length - seen.size > fresh.length;
    const message = more ? "More return emails are waiting; the next scan reads them." : null;
    await db().update(familyMailboxes).set({ lastScanAt: more ? box.lastScanAt : now, lastScanOk: true, lastScanMessage: message }).where(eq(familyMailboxes.id, id));
    return { mailboxId: id, ok: true, read, found, message };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : "Scan failed";
    await db().update(familyMailboxes).set({ lastScanOk: false, lastScanMessage: message }).where(eq(familyMailboxes.id, id));
    return { mailboxId: id, ok: false, read, found, message };
  }
}

type Extracted = Awaited<ReturnType<typeof extractReturn>>;

/**
 * Decide what one email means for the list: a new return to suggest, news
 * about one already listed (refund → suggest marking it returned; a label
 * or deadline for a listed item is a duplicate), or nothing.
 */
async function fileSuggestion(input: { mailboxId: string; member: Member; messageId: string; receivedAt: Date; extracted: Extracted }): Promise<"new" | "ignored" | "duplicate"> {
  const e = input.extracted;
  const base = { mailboxId: input.mailboxId, member: input.member, messageId: input.messageId, receivedAt: input.receivedAt };
  if (!e.isReturn || e.kind === "purchase" || !e.store) {
    await db().insert(familyReturnSuggestions).values({ ...base, status: "ignored" }).onConflictDoNothing();
    return "ignored";
  }
  const open = await db()
    .select({ id: familyPurchaseReturns.id, store: familyPurchaseReturns.store, itemName: familyPurchaseReturns.itemName, returnDeadline: familyPurchaseReturns.returnDeadline })
    .from(familyPurchaseReturns)
    .where(ne(familyPurchaseReturns.status, "returned"));
  const sameShop = open.filter((r) => sameStore(r.store, e.store!));
  const match = sameShop.find((r) => e.itemName && similarItem(r.itemName, e.itemName)) ?? (sameShop.length === 1 ? sameShop[0] : undefined);

  // Earlier, still-open suggestion for the same thing from this member: don't suggest it twice.
  const pending = await db()
    .select({ store: familyReturnSuggestions.store, itemName: familyReturnSuggestions.itemName, kind: familyReturnSuggestions.kind })
    .from(familyReturnSuggestions)
    .where(and(eq(familyReturnSuggestions.member, input.member), eq(familyReturnSuggestions.status, "new")));
  const repeat = pending.some((p) => p.kind === (e.kind === "refund" ? "refund" : p.kind) && p.store && sameStore(p.store, e.store!) && (!e.itemName || !p.itemName || similarItem(p.itemName, e.itemName)));

  const fields = { kind: e.kind, store: e.store, itemName: e.itemName, returnDeadline: e.returnDeadline, notes: e.howToReturn };
  let status: "new" | "duplicate" = "new";
  if (e.kind === "refund") {
    if (!match || repeat) status = "duplicate";
  } else if (match || repeat) {
    status = "duplicate";
  }
  await db()
    .insert(familyReturnSuggestions)
    .values({ ...base, ...fields, status, matchReturnId: match?.id ?? null })
    .onConflictDoNothing();
  return status;
}

/** Scheduled scan (hourly cron): every mailbox not scanned in the last few hours. */
export async function scanDueMailboxes(now = new Date()): Promise<{ scanned: number; failed: number; found: number }> {
  const rows = await db().select({ id: familyMailboxes.id, lastScanAt: familyMailboxes.lastScanAt }).from(familyMailboxes);
  let scanned = 0;
  let failed = 0;
  let found = 0;
  for (const r of rows) {
    if (r.lastScanAt && now.getTime() - r.lastScanAt.getTime() < SCAN_INTERVAL_MS) continue;
    const res = await scanMailbox(r.id, now);
    scanned += 1;
    if (!res.ok) failed += 1;
    found += res.found;
  }
  return { scanned, failed, found };
}

/** "Scan now" from Settings or the Returns tab: this member's mailboxes. */
export async function scanMemberMailboxes(member: Member, now = new Date()): Promise<ScanResult[]> {
  const rows = await db().select({ id: familyMailboxes.id }).from(familyMailboxes).where(eq(familyMailboxes.member, member));
  const out: ScanResult[] = [];
  for (const r of rows) out.push(await scanMailbox(r.id, now));
  return out;
}

// ----------------------------------------------------------- suggestions ----

export type ReturnSuggestion = {
  id: string;
  kind: "return_started" | "label" | "refund";
  store: string;
  itemName: string | null;
  returnDeadline: string | null;
  notes: string | null;
  /** For a refund: the listed return it is about. */
  match: { id: string; itemName: string } | null;
  /** Opens the email in Gmail (the member's own browser, signed in to that mailbox). */
  emailUrl: string;
  receivedAt: string | null;
};

/** Found returns waiting for this member to add or dismiss. Never shown to the other member or the kiosk. */
export async function listReturnSuggestions(member: Member): Promise<ReturnSuggestion[]> {
  const rows = await db()
    .select({ s: familyReturnSuggestions, addressSealed: familyMailboxes.addressSealed, matchItem: familyPurchaseReturns.itemName, matchStatus: familyPurchaseReturns.status })
    .from(familyReturnSuggestions)
    .innerJoin(familyMailboxes, eq(familyMailboxes.id, familyReturnSuggestions.mailboxId))
    .leftJoin(familyPurchaseReturns, eq(familyPurchaseReturns.id, familyReturnSuggestions.matchReturnId))
    .where(and(eq(familyReturnSuggestions.member, member), eq(familyReturnSuggestions.status, "new")))
    .orderBy(desc(familyReturnSuggestions.receivedAt))
    .limit(30);
  return rows
    .filter((r) => r.s.kind !== "refund" || (r.s.matchReturnId && r.matchStatus !== "returned"))
    .map(({ s, addressSealed, matchItem }) => {
      const address = safeOpen(addressSealed);
      const emailUrl = `https://mail.google.com/mail/u/${address ? `?authuser=${encodeURIComponent(address)}` : "0/"}#all/${encodeURIComponent(s.messageId)}`;
      return {
        id: s.id,
        kind: s.kind ?? "return_started",
        store: s.store ?? "",
        itemName: s.itemName,
        returnDeadline: s.returnDeadline,
        notes: s.notes,
        match: s.matchReturnId && matchItem ? { id: s.matchReturnId, itemName: matchItem } : null,
        emailUrl,
        receivedAt: s.receivedAt?.toISOString() ?? null,
      };
    });
}

async function ownSuggestion(member: Member, id: string) {
  const [row] = await db()
    .select()
    .from(familyReturnSuggestions)
    .where(and(eq(familyReturnSuggestions.id, id), eq(familyReturnSuggestions.member, member)));
  if (!row) throw new MailConnectError("That suggestion is gone");
  return row;
}

/** The member added it to the list (the add itself goes through addReturn / setReturnStatus). */
export async function markSuggestion(member: Member, id: string, status: "accepted" | "dismissed") {
  await ownSuggestion(member, id);
  await db().update(familyReturnSuggestions).set({ status }).where(eq(familyReturnSuggestions.id, id));
}

export async function getOwnSuggestion(member: Member, id: string) {
  return ownSuggestion(member, id);
}

/** Housekeeping: forget dismissed and non-return rows after 180 days (scans never look back that far). */
export async function pruneOldSuggestions(now = new Date()) {
  const cutoff = new Date(now.getTime() - 180 * 24 * 3600_000);
  await db()
    .delete(familyReturnSuggestions)
    .where(and(ne(familyReturnSuggestions.status, "new"), lt(familyReturnSuggestions.createdAt, cutoff)));
}
