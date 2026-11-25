import "server-only";
import { createSign } from "node:crypto";
import { and, eq, gt, gte, lt, notInArray, or } from "drizzle-orm";
import { db } from "@/core/db/client";
import { outboundFetch } from "@/core/net/outbound";
import { getSetting, setSetting } from "@/core/settings/store";
import { householdTimeZone, zonedMidnight, zonedParts } from "@/core/time/zoned";
import {
  allCalendarSources,
  EventInputError,
  findCalendarByName,
  mirrorWindow,
  toGoogleBody,
  toStoredEvent,
  type CalendarListEntry,
  type CalendarSource,
  type EventInput,
  type GoogleEvent,
} from "./google-config";
import { calendarEventPhotos, calendarGoogleEvents } from "./schema";

/**
 * Two-way Google Calendar sync for the kitchen kiosk and the phone view.
 *
 * Credentials (server-only, Railway variables), either:
 * - GOOGLE_CALENDAR_SERVICE_ACCOUNT: a service account JSON key (raw or
 *   base64). Share the family calendar with the service account's address
 *   ("Make changes to events") and set GOOGLE_CALENDAR_ID, since a service
 *   account's calendar list does not show calendars shared with it.
 * - GOOGLE_REFRESH_TOKEN (or GOOGLE_CALENDAR_REFRESH_TOKEN): a refresh token
 *   for one member, issued to GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   (falling back to the sign-in client AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET)
 *   with the calendar.events and calendar.calendarlist.readonly scopes.
 *   The family calendar is then found by its name.
 *
 * Only oauth2.googleapis.com and www.googleapis.com are called, both already
 * on the outbound allowlist. Events are mirrored from the start of this
 * month's grid (or yesterday) to 10 weeks out (mirrorWindow); only title, time, location and all-day are kept, plus the
 * etag and update time so an edit never overwrites a newer change.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
].join(" ");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SYNC_STATE_KEY = "calendar.googleSync";
const MIN_INTERVAL_MS = 60_000;
const EVENT_FIELDS = "id,etag,status,summary,location,description,updated,recurringEventId,start,end";

export type GoogleSyncState = { lastSyncAt: string | null; ok: boolean; message: string | null };

export function calendarSources(): CalendarSource[] {
  return allCalendarSources(process.env);
}

function refreshToken() {
  return process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
}

export function googleCalendarConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT || refreshToken());
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
      JSON.stringify({ iss: sa.client_email, scope: SCOPES, aud: TOKEN_URL, iat, exp: iat + 3600 }),
    )}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
    body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(signature)}`,
    });
  } else {
    const refresh = refreshToken();
    if (!refresh) throw new Error("Google Calendar is not configured");
    body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: process.env.GOOGLE_CLIENT_ID || process.env.AUTH_GOOGLE_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET || "",
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

async function google(path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<Response> {
  const token = await accessToken();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return outboundFetch(url, { ...init, headers });
}

/**
 * Calendar ids found by name, kept in memory only (they are often email
 * addresses). Looked up again after a restart, or after an hour.
 */
const discovered = new Map<string, { id: string; canWrite: boolean; at: number }>();
const DISCOVERY_TTL_MS = 60 * 60_000;

async function resolveCalendar(source: CalendarSource): Promise<{ id: string; canWrite: boolean }> {
  if (source.calendarId) return { id: source.calendarId, canWrite: source.writable };
  const name = source.findByName ?? source.label;
  const hit = discovered.get(name);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit;

  const items: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await google("/users/me/calendarList", {
      query: { minAccessRole: "reader", fields: "nextPageToken,items(id,summary,summaryOverride,accessRole)", ...(pageToken ? { pageToken } : {}) },
    });
    if (!res.ok) throw new Error(`${source.label}: couldn't list calendars (HTTP ${res.status})`);
    const json = (await res.json()) as { items?: CalendarListEntry[]; nextPageToken?: string };
    items.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  const found = findCalendarByName(items, name);
  if (!found) {
    throw new Error(
      `No calendar named "${name}" is visible to the calendar credential. Share it with that account, or set GOOGLE_CALENDAR_ID.`,
    );
  }
  discovered.set(name, { ...found, at: Date.now() });
  return found;
}

async function fetchEvents(calendarId: string, label: string, timeMin: Date, timeMax: Date): Promise<GoogleEvent[]> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await google(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: {
        singleEvents: "true",
        orderBy: "startTime",
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        maxResults: "250",
        fields: `nextPageToken,items(${EVENT_FIELDS})`,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    // The label, never the calendar id, goes into messages.
    if (!res.ok) throw new Error(`${label}: Google Calendar answered HTTP ${res.status}`);
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
 * Mirrors the next days of every configured calendar. Runs at most once a
 * minute (Sync button, page loads, cron) and never twice at the same time.
 */
export async function syncGoogleCalendars(opts: { now?: Date; maxAgeMs?: number; force?: boolean } = {}): Promise<GoogleSyncState> {
  const now = opts.now ?? new Date();
  if (!googleCalendarConfigured()) {
    return { lastSyncAt: null, ok: false, message: "Google Calendar is not set up" };
  }
  const state = await googleSyncState();
  const age = state.lastSyncAt ? now.getTime() - Date.parse(state.lastSyncAt) : Infinity;
  if (!opts.force && age < Math.max(MIN_INTERVAL_MS, opts.maxAgeMs ?? 0)) return state;
  running ??= runSync(now).finally(() => {
    running = null;
  });
  return running;
}

async function runSync(now: Date): Promise<GoogleSyncState> {
  const tz = householdTimeZone();
  const today = zonedParts(now, tz).date;
  const window = mirrorWindow(today);
  const windowStart = zonedMidnight(window.from, tz);
  const windowEnd = zonedMidnight(window.to, tz);
  const sources = calendarSources();
  const failures: string[] = [];

  for (const source of sources) {
    try {
      const cal = await resolveCalendar(source);
      const events = (await fetchEvents(cal.id, source.label, windowStart, windowEnd))
        .map(toStoredEvent)
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map((e) => (source.hideNotes ? { ...e, notes: null } : e));
      await db().transaction(async (tx) => {
        for (const e of events) {
          const row = { ...e, calendarKey: source.key, lastSyncedAt: now };
          await tx
            .insert(calendarGoogleEvents)
            .values(row)
            .onConflictDoUpdate({ target: [calendarGoogleEvents.calendarKey, calendarGoogleEvents.googleEventId], set: row });
        }
        // Anything not seen this time was deleted in Google or left the window.
        const seen = events.map((e) => e.googleEventId);
        await tx
          .delete(calendarGoogleEvents)
          .where(
            seen.length
              ? and(eq(calendarGoogleEvents.calendarKey, source.key), notInArray(calendarGoogleEvents.googleEventId, seen))
              : eq(calendarGoogleEvents.calendarKey, source.key),
          );
      });
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  // Calendars removed from the configuration disappear from the screen.
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

// ---- Writing to the family calendar -------------------------------------

/** A message safe to show on the screen (never a calendar id). */
export class CalendarWriteError extends Error {}

function familySource(): CalendarSource {
  const s = calendarSources().find((x) => x.writable);
  if (!s || !googleCalendarConfigured()) throw new CalendarWriteError("Google Calendar isn't connected yet.");
  return s;
}

async function writableCalendar(): Promise<{ source: CalendarSource; id: string }> {
  const source = familySource();
  let cal: { id: string; canWrite: boolean };
  try {
    cal = await resolveCalendar(source);
  } catch (err) {
    throw new CalendarWriteError(err instanceof Error ? err.message : "Couldn't reach Google Calendar.");
  }
  if (!cal.canWrite) throw new CalendarWriteError(`The app can only read "${source.label}". Give its Google account permission to make changes.`);
  return { source, id: cal.id };
}

async function failure(res: Response, what: string): Promise<never> {
  if (res.status === 412) {
    throw new CalendarWriteError("Someone changed this event in the meantime. The screen has been refreshed; try again.");
  }
  if (res.status === 403) throw new CalendarWriteError(`Google refused to ${what} (no permission to change this calendar).`);
  throw new CalendarWriteError(`Google couldn't ${what} (HTTP ${res.status}). Try again.`);
}

async function saveMirror(sourceKey: string, event: GoogleEvent) {
  const stored = toStoredEvent(event);
  if (!stored) return;
  const row = { ...stored, calendarKey: sourceKey, lastSyncedAt: new Date() };
  await db()
    .insert(calendarGoogleEvents)
    .values(row)
    .onConflictDoUpdate({ target: [calendarGoogleEvents.calendarKey, calendarGoogleEvents.googleEventId], set: row });
}

function bodyOf(input: EventInput, patch: boolean) {
  try {
    return toGoogleBody(input, householdTimeZone(), { patch });
  } catch (err) {
    if (err instanceof EventInputError) throw new CalendarWriteError(err.message);
    throw err;
  }
}

/** Adds an event to the family calendar (events.insert) and to the local mirror. */
export async function createGoogleEvent(input: EventInput): Promise<void> {
  const body = bodyOf(input, false);
  const { source, id } = await writableCalendar();
  const res = await google(`/calendars/${encodeURIComponent(id)}/events`, {
    method: "POST",
    query: { fields: EVENT_FIELDS },
    body: JSON.stringify(body),
  });
  if (!res.ok) await failure(res, "add the event");
  await saveMirror(source.key, (await res.json()) as GoogleEvent);
}

export async function mirroredFamilyEvent(eventId: string) {
  const source = familySource();
  const [row] = await db()
    .select()
    .from(calendarGoogleEvents)
    .where(and(eq(calendarGoogleEvents.id, eventId), eq(calendarGoogleEvents.calendarKey, source.key)));
  if (!row) throw new CalendarWriteError("That event can't be changed here. Only events on the family calendar can.");
  return row;
}

/** Changes an event on the family calendar (events.patch, If-Match etag). */
export async function updateGoogleEvent(eventId: string, input: EventInput): Promise<void> {
  const row = await mirroredFamilyEvent(eventId);
  // Notes left as they were are not sent, so formatting added in Google Calendar survives.
  const unchangedNotes = (input.notes ?? null)?.trim() === (row.notes ?? null)?.trim() || ((input.notes ?? "").trim() === "" && !row.notes);
  const body = bodyOf(unchangedNotes ? { ...input, notes: undefined } : input, true);
  const { source, id } = await writableCalendar();
  const res = await google(`/calendars/${encodeURIComponent(id)}/events/${encodeURIComponent(row.googleEventId)}`, {
    method: "PATCH",
    query: { fields: EVENT_FIELDS },
    headers: row.etag ? { "if-match": row.etag } : undefined,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 412) await syncGoogleCalendars({ force: true }).catch(() => undefined);
    await failure(res, "save the change");
  }
  await saveMirror(source.key, (await res.json()) as GoogleEvent);
}

/** Deletes an event from the family calendar (events.delete, If-Match etag). */
export async function deleteGoogleEvent(eventId: string): Promise<void> {
  const row = await mirroredFamilyEvent(eventId);
  const { id } = await writableCalendar();
  const res = await google(`/calendars/${encodeURIComponent(id)}/events/${encodeURIComponent(row.googleEventId)}`, {
    method: "DELETE",
    headers: row.etag ? { "if-match": row.etag } : undefined,
  });
  // 404/410: already gone in Google.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    if (res.status === 412) await syncGoogleCalendars({ force: true }).catch(() => undefined);
    await failure(res, "delete the event");
  }
  await db().delete(calendarGoogleEvents).where(eq(calendarGoogleEvents.id, row.id));
  await db()
    .delete(calendarEventPhotos)
    .where(and(eq(calendarEventPhotos.calendarKey, row.calendarKey), eq(calendarEventPhotos.googleEventId, row.googleEventId)));
}
