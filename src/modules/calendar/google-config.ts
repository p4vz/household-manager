import { addDays, zonedParts } from "@/core/time/zoned";

/**
 * Which Google calendars the kiosk shows, and how events travel to and from
 * Google. Pure, so it is unit tested.
 *
 * The family calendar ("Pavel + Raisa" by default) is the one the kiosk and
 * phones write to. It is found by name in the credential's calendar list
 * (GOOGLE_CALENDAR_NAME), or given directly with GOOGLE_CALENDAR_ID.
 *
 * GOOGLE_CALENDARS adds more calendars, shown read-only, one per line or
 * separated by ";":
 *
 *   Pavel|#2563eb|primary-calendar-id@gmail.com
 *   Kids|#16a34a|abc123@group.calendar.google.com
 *
 * The label and colour are shown on the screen. Calendar ids stay on the
 * server: they are often email addresses, so they are never stored in the
 * database or sent to a browser.
 */
export type CalendarSource = {
  key: string;
  label: string;
  color: string;
  /** Null until found by name (see `findByName`). */
  calendarId: string | null;
  /** Calendar title to look up in the credential's calendar list. */
  findByName?: string;
  /** Events can be added, edited and deleted from the kiosk and phones. */
  writable: boolean;
};

export const DEFAULT_CALENDAR_NAME = "Pavel + Raisa";
export const FAMILY_KEY = "family";
const FAMILY_COLOR = "#0d9488";
const FALLBACK_COLORS = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2"];
const isHex = (v: string | undefined) => Boolean(v && /^#[0-9a-fA-F]{6}$/.test(v));

function keyOf(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** The extra, read-only calendars from GOOGLE_CALENDARS. */
export function parseCalendarSources(raw: string | undefined): CalendarSource[] {
  const out: CalendarSource[] = [];
  const seen = new Set<string>([FAMILY_KEY]);
  for (const entry of (raw ?? "").split(/[;\n]/)) {
    const parts = entry.split("|").map((p) => p.trim());
    if (parts.length < 2) continue;
    const [label, maybeColor, maybeId] = parts;
    const calendarId = parts.length >= 3 ? maybeId : maybeColor;
    const colorRaw = parts.length >= 3 ? maybeColor : "";
    if (!label || !calendarId) continue;
    const key = keyOf(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const color = isHex(colorRaw) ? colorRaw.toLowerCase() : FALLBACK_COLORS[out.length % FALLBACK_COLORS.length];
    out.push({ key, label: label.slice(0, 40), color, calendarId, writable: false });
  }
  return out;
}

type Env = Record<string, string | undefined>;

/** The shared family calendar the app writes to. */
export function familyCalendarSource(env: Env): CalendarSource {
  const id = env.GOOGLE_CALENDAR_ID?.trim() || null;
  const name = env.GOOGLE_CALENDAR_NAME?.trim() || DEFAULT_CALENDAR_NAME;
  const label = (env.GOOGLE_CALENDAR_LABEL?.trim() || name).slice(0, 40);
  const color = isHex(env.GOOGLE_CALENDAR_COLOR) ? env.GOOGLE_CALENDAR_COLOR!.toLowerCase() : FAMILY_COLOR;
  return id
    ? { key: FAMILY_KEY, label, color, calendarId: id, writable: true }
    : { key: FAMILY_KEY, label, color, calendarId: null, findByName: name, writable: true };
}

/** Family calendar first, then the extras (an extra that repeats the family calendar id is dropped). */
export function allCalendarSources(env: Env): CalendarSource[] {
  const family = familyCalendarSource(env);
  const extras = parseCalendarSources(env.GOOGLE_CALENDARS).filter((s) => !family.calendarId || s.calendarId !== family.calendarId);
  return [family, ...extras];
}

/** How far ahead the kiosk's week view can scroll (and the sync mirrors). */
export const KIOSK_DAYS_AHEAD = 70;

/** Sunday on or before the 1st of the month `date` is in: where the month grid starts. */
export function monthGridStart(date: string): string {
  const first = `${date.slice(0, 8)}01`;
  return addDays(first, -new Date(`${first}T00:00:00Z`).getUTCDay());
}

/** The days mirrored from Google: this month's grid (at least from yesterday) to KIOSK_DAYS_AHEAD days out. */
export function mirrorWindow(today: string): { from: string; to: string } {
  const gridStart = monthGridStart(today);
  const yesterday = addDays(today, -1);
  return { from: gridStart < yesterday ? gridStart : yesterday, to: addDays(today, KIOSK_DAYS_AHEAD) };
}

/** An entry of calendarList.list. */
export type CalendarListEntry = { id?: string; summary?: string; summaryOverride?: string; accessRole?: string };

/** Finds a calendar by its title (or the name the user gave it), ignoring case and spacing. */
export function findCalendarByName(items: CalendarListEntry[], name: string): { id: string; canWrite: boolean } | null {
  const norm = (v: string | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(name);
  const hit = items.find((c) => c.id && (norm(c.summaryOverride) === want || norm(c.summary) === want));
  return hit?.id ? { id: hit.id, canWrite: hit.accessRole === "owner" || hit.accessRole === "writer" } : null;
}

/** A Google event as the API returns it (only the fields we ask for). */
export type GoogleEvent = {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  location?: string;
  updated?: string;
  recurringEventId?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};

export type StoredGoogleEvent = {
  googleEventId: string;
  etag: string | null;
  googleUpdatedAt: Date | null;
  recurring: boolean;
  title: string;
  location: string | null;
  allDay: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  startDate: string | null;
  endDate: string | null;
};

/** Keeps only what the kiosk shows: title, time range and location (plus etag and updated time for safe edits). */
export function toStoredEvent(e: GoogleEvent): StoredGoogleEvent | null {
  if (!e.id || e.status === "cancelled" || !e.start) return null;
  const title = (e.summary ?? "").trim().slice(0, 200) || "Busy";
  const location = e.location?.trim().slice(0, 200) || null;
  const updated = e.updated ? new Date(e.updated) : null;
  const base = {
    googleEventId: e.id,
    etag: e.etag ?? null,
    googleUpdatedAt: updated && !Number.isNaN(updated.getTime()) ? updated : null,
    recurring: Boolean(e.recurringEventId),
    title,
    location,
  };
  if (e.start.date) {
    return { ...base, allDay: true, startsAt: null, endsAt: null, startDate: e.start.date, endDate: e.end?.date ?? null };
  }
  if (!e.start.dateTime) return null;
  const startsAt = new Date(e.start.dateTime);
  const endsAt = e.end?.dateTime ? new Date(e.end.dateTime) : startsAt;
  if (Number.isNaN(startsAt.getTime())) return null;
  return { ...base, allDay: false, startsAt, endsAt, startDate: null, endDate: null };
}

/**
 * An event as typed on the kiosk or a phone, in household wall-clock time.
 * All-day events use startDate..endDate inclusive; timed events run from
 * startDate startTime to endDate endTime.
 */
export type EventInput = {
  title: string;
  location?: string | null;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime?: string | null;
  endTime?: string | null;
};

export class EventInputError extends Error {}

/** Checks an EventInput and returns the request body for events.insert / events.patch. */
export function toGoogleBody(input: EventInput, tz: string, opts: { patch?: boolean } = {}) {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new EventInputError("Give the event a name.");
  if (input.endDate < input.startDate) throw new EventInputError("The event ends before it starts.");
  const location = input.location?.trim().slice(0, 200) || (opts.patch ? null : undefined);
  if (input.allDay) {
    return {
      summary: title,
      location,
      // Google's all-day end date is exclusive.
      start: { date: input.startDate, ...(opts.patch ? { dateTime: null, timeZone: null } : {}) },
      end: { date: addDays(input.endDate, 1), ...(opts.patch ? { dateTime: null, timeZone: null } : {}) },
    };
  }
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!input.startTime || !time.test(input.startTime) || !input.endTime || !time.test(input.endTime)) {
    throw new EventInputError("Pick a start and end time.");
  }
  if (`${input.endDate}T${input.endTime}` <= `${input.startDate}T${input.startTime}`) {
    throw new EventInputError("The event ends before it starts.");
  }
  return {
    summary: title,
    location,
    start: { dateTime: `${input.startDate}T${input.startTime}:00`, timeZone: tz, ...(opts.patch ? { date: null } : {}) },
    end: { dateTime: `${input.endDate}T${input.endTime}:00`, timeZone: tz, ...(opts.patch ? { date: null } : {}) },
  };
}

const hhmm = (at: Date, tz: string) => {
  const p = zonedParts(at, tz);
  return { date: p.date, time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` };
};

/** The edit form's starting values for a stored event. */
export function toEventInput(
  e: Pick<StoredGoogleEvent, "title" | "location" | "allDay" | "startsAt" | "endsAt" | "startDate" | "endDate">,
  tz: string,
): EventInput {
  if (e.allDay && e.startDate) {
    const last = e.endDate && e.endDate > e.startDate ? addDays(e.endDate, -1) : e.startDate;
    return { title: e.title, location: e.location, allDay: true, startDate: e.startDate, endDate: last, startTime: null, endTime: null };
  }
  const start = hhmm(e.startsAt ?? new Date(), tz);
  const end = hhmm(e.endsAt ?? e.startsAt ?? new Date(), tz);
  return { title: e.title, location: e.location, allDay: false, startDate: start.date, endDate: end.date, startTime: start.time, endTime: end.time };
}
