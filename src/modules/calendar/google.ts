import "server-only";
import { createSign } from "node:crypto";
import { and, eq, gt, gte, lt, notInArray, or } from "drizzle-orm";
import { db } from "@/core/db/client";
import { outboundFetch } from "@/core/net/outbound";
import { getSetting, setSetting } from "@/core/settings/store";
import { addDays, householdTimeZone, zonedMidnight, zonedParts } from "@/core/time/zoned";
import { parseCalendarSources, toStoredEvent, type CalendarSource, type GoogleEvent } from "./google-config";
import { calendarGoogleEvents } from "./schema";

/**
 * Read-only Google Calendar sync for the kitchen kiosk.
 *
 * Credentials (server-only, Railway variables), either:
 * - GOOGLE_CALENDAR_SERVICE_ACCOUNT: a service account JSON key (raw or
 *   base64). Share each family calendar with the service account's address
 *   ("See all event details"). Preferred: it can only read what was shared.
 * - GOOGLE_CALENDAR_REFRESH_TOKEN: a refresh token for one member, issued to
 *   this app's Google OAuth client (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET) with
 *   the calendar.readonly scope.
 *
 * Only oauth2.googleapis.com and www.googleapis.com are called, both already
 * on the outbound allowlist. Events are copied for yesterday through the
 * next 9 days; only title, time, location and all-day are kept.
 */
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SYNC_STATE_KEY = "calendar.googleSync";
const MIN_INTERVAL_MS = 60_000;

export type GoogleSyncState = { lastSyncAt: string | null; ok: boolean; message: string | null };

export function calendarSources(): CalendarSource[] {
  return parseCalendarSources(process.env.GOOGLE_CALENDARS);
}

export function googleCalendarConfigured(): boolean {
  return (
    calendarSources().length > 0 &&
    Boolean(process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || process.env.GOOGLE_CALENDAR_REFRESH_TOKEN)
  );
}

let cachedToken: { value: string; expiresAt: number } | null = null;

function serviceAccount(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(json) as { client_email?: string; private_key?: string };
  if (!parsed.client_email || !parsed.private_key) throw new Error("Service account key is missing fields");
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

async function accessToken(now = Date.now()): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;
  const sa = serviceAccount();
  let body: URLSearchParams;
  if (sa) {
    const iat = Math.floor(now / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
    )}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
    body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(signature)}`,
    });
  } else {
    const refresh = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
    if (!refresh) throw new Error("Google Calendar is not configured");
    body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: process.env.AUTH_GOOGLE_ID ?? "",
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
    });
  }
  const res = await outboundFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Google token request failed (HTTP ${res.status})`);
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Google token response had no access token");
  cachedToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

async function fetchEvents(source: CalendarSource, timeMin: Date, timeMax: Date): Promise<GoogleEvent[]> {
  const token = await accessToken();
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.calendarId)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeMin", timeMin.toISOString());
    url.searchParams.set("timeMax", timeMax.toISOString());
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("fields", "nextPageToken,items(id,status,summary,location,start,end)");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await outboundFetch(url, { headers: { authorization: `Bearer ${token}` } });
    // The label, never the calendar id, goes into messages.
    if (!res.ok) throw new Error(`${source.label}: Google Calendar answered HTTP ${res.status}`);
    const json = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    items.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

let running: Promise<GoogleSyncState> | null = null;

export async function googleSyncState(): Promise<GoogleSyncState> {
  const s = (await getSetting(SYNC_STATE_KEY)) as GoogleSyncState | undefined;
  return s ?? { lastSyncAt: null, ok: false, message: null };
}

/**
 * Copies the next days of every configured calendar. Runs at most once a
 * minute (manual button) and never twice at the same time.
 */
export async function syncGoogleCalendars(opts: { now?: Date; maxAgeMs?: number } = {}): Promise<GoogleSyncState> {
  const now = opts.now ?? new Date();
  if (!googleCalendarConfigured()) {
    return { lastSyncAt: null, ok: false, message: "Google Calendar is not set up" };
  }
  const state = await googleSyncState();
  const age = state.lastSyncAt ? now.getTime() - Date.parse(state.lastSyncAt) : Infinity;
  if (age < Math.max(MIN_INTERVAL_MS, opts.maxAgeMs ?? 0)) return state;
  running ??= runSync(now).finally(() => {
    running = null;
  });
  return running;
}

async function runSync(now: Date): Promise<GoogleSyncState> {
  const tz = householdTimeZone();
  const today = zonedParts(now, tz).date;
  const windowStart = zonedMidnight(addDays(today, -1), tz);
  const windowEnd = zonedMidnight(addDays(today, 10), tz);
  const sources = calendarSources();
  const failures: string[] = [];

  for (const source of sources) {
    try {
      const events = (await fetchEvents(source, windowStart, windowEnd))
        .map(toStoredEvent)
        .filter((e): e is NonNullable<typeof e> => e !== null);
      await db().transaction(async (tx) => {
        await tx.delete(calendarGoogleEvents).where(eq(calendarGoogleEvents.calendarKey, source.key));
        if (events.length) {
          await tx.insert(calendarGoogleEvents).values(events.map((e) => ({ ...e, calendarKey: source.key, syncedAt: now })));
        }
      });
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  // Calendars removed from GOOGLE_CALENDARS disappear from the screen.
  const keys = sources.map((s) => s.key);
  if (keys.length) await db().delete(calendarGoogleEvents).where(notInArray(calendarGoogleEvents.calendarKey, keys));

  const next: GoogleSyncState = {
    lastSyncAt: now.toISOString(),
    ok: failures.length === 0,
    message: failures.length ? failures.join("; ").slice(0, 300) : null,
  };
  await setSetting(SYNC_STATE_KEY, next);
  if (failures.length) console.error(`[calendar] Google sync: ${next.message}`);
  return next;
}

/** Stored Google events overlapping [from, to); all-day end dates are exclusive. */
export async function storedGoogleEvents(from: Date, to: Date, fromDate: string, toDate: string) {
  return db()
    .select()
    .from(calendarGoogleEvents)
    .where(
      or(
        and(eq(calendarGoogleEvents.allDay, false), lt(calendarGoogleEvents.startsAt, to), gte(calendarGoogleEvents.endsAt, from)),
        and(eq(calendarGoogleEvents.allDay, true), lt(calendarGoogleEvents.startDate, toDate), gt(calendarGoogleEvents.endDate, fromDate)),
      ),
    );
}

