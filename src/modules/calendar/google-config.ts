/**
 * GOOGLE_CALENDARS lists the family calendars shown on the kiosk, one per
 * line or separated by ";":
 *
 *   Pavel|#2563eb|primary-calendar-id@gmail.com
 *   Raisa|#db2777|other-id@gmail.com
 *   Kids|#16a34a|abc123@group.calendar.google.com
 *
 * The label (a first name or "Kids", "Family") and colour are shown on the
 * screen. The calendar id stays on the server: it is often an email address,
 * so it is never stored in the database or sent to a browser.
 */
export type CalendarSource = { key: string; label: string; color: string; calendarId: string };

const FALLBACK_COLORS = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2"];

export function parseCalendarSources(raw: string | undefined): CalendarSource[] {
  const out: CalendarSource[] = [];
  const seen = new Set<string>();
  for (const entry of (raw ?? "").split(/[;\n]/)) {
    const parts = entry.split("|").map((p) => p.trim());
    if (parts.length < 2) continue;
    const [label, maybeColor, maybeId] = parts;
    const calendarId = parts.length >= 3 ? maybeId : maybeColor;
    const colorRaw = parts.length >= 3 ? maybeColor : "";
    if (!label || !calendarId) continue;
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const color = /^#[0-9a-fA-F]{6}$/.test(colorRaw) ? colorRaw.toLowerCase() : FALLBACK_COLORS[out.length % FALLBACK_COLORS.length];
    out.push({ key, label: label.slice(0, 40), color, calendarId });
  }
  return out;
}

/** A Google event as the API returns it (only the fields we ask for). */
export type GoogleEvent = {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};

export type StoredGoogleEvent = {
  googleEventId: string;
  title: string;
  location: string | null;
  allDay: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  startDate: string | null;
  endDate: string | null;
};

/** Keeps only what the kiosk shows: title, time range and location. */
export function toStoredEvent(e: GoogleEvent): StoredGoogleEvent | null {
  if (!e.id || e.status === "cancelled" || !e.start) return null;
  const title = (e.summary ?? "").trim().slice(0, 200) || "Busy";
  const location = e.location?.trim().slice(0, 200) || null;
  if (e.start.date) {
    return {
      googleEventId: e.id,
      title,
      location,
      allDay: true,
      startsAt: null,
      endsAt: null,
      startDate: e.start.date,
      endDate: e.end?.date ?? null,
    };
  }
  if (!e.start.dateTime) return null;
  const startsAt = new Date(e.start.dateTime);
  const endsAt = e.end?.dateTime ? new Date(e.end.dateTime) : startsAt;
  if (Number.isNaN(startsAt.getTime())) return null;
  return { googleEventId: e.id, title, location, allDay: false, startsAt, endsAt, startDate: null, endDate: null };
}
