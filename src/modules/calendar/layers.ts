import { addDays } from "@/core/time/zoned";
import type { GoogleEvent } from "./google-config";

/**
 * Read-only calendar layers that don't come from Google (Pavel, 2026-11-25):
 *
 * - "School (RHES)": the kids' school year, typed in from the printed
 *   2026–27 calendar. Built into the app; RHES_CALENDAR=off hides it.
 * - "Abington Township": weekly trash & recycling pick-ups (moved for
 *   township holidays), leaf collection weeks for the household's leaf area,
 *   recycling/shredding/clean-out events, events at Roychester Park, and
 *   anything about the new middle school's construction. Read from the
 *   township's and the school district's public iCalendar feeds (fixed URLs,
 *   plain GETs). ABINGTON_TOWNSHIP=off hides it; ABINGTON_LEAF_AREA (A–O,
 *   default F) and ABINGTON_TRASH_DAY (default Friday) hold the household's
 *   zone. Only the zone is kept, never the street address.
 *
 * Both are turned into the same shape as Google events so they are mirrored,
 * windowed and shown exactly like the US holidays layer. Pure, so it is unit
 * tested.
 */

export const SCHOOL_KEY = "school-rhes";
export const TOWNSHIP_KEY = "abington-township";
export const SCHOOL_COLOR = "#ca8a04";
export const TOWNSHIP_COLOR = "#475569";

/** [title, first day, last day (inclusive)]. Read from the RHES 2026–27 school year calendar. */
export const RHES_2026_27: ReadonlyArray<readonly [string, string, string?]> = [
  ["First day of school", "2026-08-24"],
  ["No school: Labor Day", "2026-09-07"],
  ["No school: Yom Kippur", "2026-09-21"],
  ["No school: Thanksgiving", "2026-11-26", "2026-11-27"],
  ["Winter break (no school)", "2026-12-21", "2027-01-01"],
  ["Spring break (no school)", "2027-03-22", "2027-03-28"],
  ["No school: Memorial Day", "2027-05-31"],
  ["Last day of school", "2027-06-11"],
];

/** The school calendar as all-day events (Google-style exclusive end date). */
export function schoolEvents(): GoogleEvent[] {
  return RHES_2026_27.map(([title, first, last]) => ({
    id: `rhes-${first}`,
    status: "confirmed",
    summary: title,
    start: { date: first },
    end: { date: addDays(last ?? first, 1) },
  }));
}

export const TOWNSHIP_HOST = "www.abingtonpa.gov";
export const DISTRICT_HOST = "thrillshare-cmsv2.services.thrillshare.com";

/** What the township layer pulls in, and which of each feed's events it keeps. */
export type TownshipFeed = { url: string; label: string; keep: (title: string, location: string) => boolean };

const RECYCLING = /recycl|shred|clean[- ]?out|e-?waste|hazardous|large item/i;
const ROYCHESTER = /roychester/i;
const MIDDLE_SCHOOL_WORKS = /(middle school|junior high).*(construct|project|groundbreak|demoli|building|design|community meeting|open house|town hall)|(construct|groundbreak|demoli)\w*.*(middle school|junior high)/i;

/** "Leaf Collection - Areas C\, D\, F\, J" / "Leaf Collection - All Areas" for the household's area. */
export function isOurLeafCollection(title: string, area: string): boolean {
  const m = /leaf collection\s*[-:–]\s*(.+)$/i.exec(title);
  if (!m) return false;
  if (/all areas/i.test(m[1])) return true;
  const letters = m[1].replace(/^areas?\s*/i, "").split(/[^A-Za-z]+/).filter(Boolean);
  return letters.some((l) => l.toUpperCase() === area.toUpperCase());
}

type Env = Record<string, string | undefined>;

/** The household's leaf collection area (A–O). Only the area letter is kept, never the address. */
export function leafArea(env: Env): string {
  const v = env.ABINGTON_LEAF_AREA?.trim().toUpperCase();
  return v && /^[A-O]$/.test(v) ? v : "F";
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Trash and recycling day (0 = Sunday … 6 = Saturday). */
export function trashWeekday(env: Env): number {
  const i = WEEKDAYS.indexOf(env.ABINGTON_TRASH_DAY?.trim().toLowerCase() ?? "");
  return i >= 1 && i <= 5 ? i : 5;
}

/**
 * Feeds for the township layer: the township's public events and meetings
 * calendars, and the school district's public calendar (for the new middle
 * school works). Fixed URLs; only matching events are kept.
 */
export function townshipFeeds(env: Env): TownshipFeed[] {
  const area = leafArea(env);
  const civic = (cat: number) => `https://${TOWNSHIP_HOST}/common/modules/iCalendar/iCalendar.aspx?catID=${cat}&feed=calendar`;
  return [
    {
      url: civic(25),
      label: "township events",
      keep: (t, loc) => isOurLeafCollection(t, area) || RECYCLING.test(t) || ROYCHESTER.test(`${t} ${loc}`) || MIDDLE_SCHOOL_WORKS.test(t),
    },
    { url: civic(23), label: "township meetings", keep: (t, loc) => MIDDLE_SCHOOL_WORKS.test(t) || ROYCHESTER.test(`${t} ${loc}`) },
    {
      url: `https://${DISTRICT_HOST}/api/v4/o/13737/cms/events/generate_ical?filter_ids&section_ids`,
      label: "school district",
      keep: (t) => MIDDLE_SCHOOL_WORKS.test(t),
    },
  ];
}

/** Day of the week of a date (0 = Sunday). */
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The n-th given weekday of a month (n = -1 for the last). */
function nthWeekday(y: number, m: number, wd: number, n: number): string {
  if (n > 0) {
    const first = ymd(y, m, 1);
    return addDays(first, ((wd - weekday(first) + 7) % 7) + (n - 1) * 7);
  }
  const last = addDays(ymd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1), -1);
  return addDays(last, -((weekday(last) - wd + 7) % 7));
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return ymd(y, month, ((h + l - 7 * m + 114) % 31) + 1);
}

/** A fixed-date holiday as observed: Saturday moves to Friday, Sunday to Monday. */
function observed(date: string): string {
  const wd = weekday(date);
  return wd === 6 ? addDays(date, -1) : wd === 0 ? addDays(date, 1) : date;
}

/**
 * Days the township is closed and does not collect trash (Trash Collection
 * FAQ on abingtonpa.gov): New Year's, MLK, Presidents', Good Friday,
 * Memorial, Juneteenth, Independence, Labor, Columbus, Veterans,
 * Thanksgiving and Christmas Day.
 */
export function townshipClosedDays(year: number): Map<string, string> {
  const days: [string, string][] = [
    [observed(ymd(year, 1, 1)), "New Year's Day"],
    [nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day"],
    [nthWeekday(year, 2, 1, 3), "Presidents' Day"],
    [addDays(easter(year), -2), "Good Friday"],
    [nthWeekday(year, 5, 1, -1), "Memorial Day"],
    [observed(ymd(year, 6, 19)), "Juneteenth"],
    [observed(ymd(year, 7, 4)), "Independence Day"],
    [nthWeekday(year, 9, 1, 1), "Labor Day"],
    [nthWeekday(year, 10, 1, 2), "Columbus Day"],
    [observed(ymd(year, 11, 11)), "Veterans Day"],
    [nthWeekday(year, 11, 4, 4), "Thanksgiving"],
    [observed(ymd(year, 12, 25)), "Christmas Day"],
  ];
  return new Map(days);
}

/** Next business day after `date` (skips weekends and township closed days). */
function nextBusinessDay(date: string): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 10; i++) {
    const closed = townshipClosedDays(Number(d.slice(0, 4)));
    if (weekday(d) !== 0 && weekday(d) !== 6 && !closed.has(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

/**
 * Weekly trash and recycling pick-ups from `from` to `to` (exclusive). When
 * the township is closed on the usual day, pick-up moves to the next
 * business day, as the township's FAQ says.
 */
export function trashEvents(env: Env, from: string, to: string): GoogleEvent[] {
  const wd = trashWeekday(env);
  const out: GoogleEvent[] = [];
  let d = addDays(from, (wd - weekday(from) + 7) % 7);
  for (; d < to; d = addDays(d, 7)) {
    const holiday = townshipClosedDays(Number(d.slice(0, 4))).get(d);
    const day = holiday ? nextBusinessDay(d) : d;
    out.push({
      id: `trash-${d}`,
      status: "confirmed",
      summary: holiday ? `Trash & recycling (moved for ${holiday})` : "Trash & recycling",
      description: "Carts at the curb by 7 am.",
      start: { date: day },
      end: { date: addDays(day, 1) },
    });
  }
  return out;
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
}

/** "20261213T160000" -> "2026-12-13T16:00:00"; "20261213" -> "2026-12-13". */
function icsDate(v: string): { date?: string; local?: string; utc?: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { date };
  return { local: `${date}T${m[4]}:${m[5]}:${m[6]}`, utc: Boolean(m[7]) };
}

/** Offset of `tz` at a UTC instant, as "+HH:MM" / "-HH:MM". */
function offsetAt(utcMs: number, tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

/** A wall-clock time in `tz` as an RFC 3339 timestamp. */
function zonedIso(local: string, tz: string): string {
  const guess = Date.parse(`${local}Z`);
  const first = offsetAt(guess, tz);
  const ms = Date.parse(`${local}${first}`);
  return `${local}${offsetAt(ms, tz)}`;
}

/**
 * Parses an iCalendar feed into Google-shaped events. Handles what the
 * township's CivicPlus feed sends: all-day (VALUE=DATE) and timed events in
 * the feed's time zone, one VEVENT each (no repeat rules). Descriptions are
 * just a link back to the site, so they are dropped.
 */
export function parseIcs(text: string, tz: string, idPrefix: string): GoogleEvent[] {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const feedTz = /^X-WR-TIMEZONE:(.+)$/m.exec(unfolded)?.[1]?.trim() || tz;
  const out: GoogleEvent[] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const field = (name: string) => {
      const m = new RegExp(`^${name}(;[^:\\n]*)?:(.*)$`, "m").exec(body);
      return m ? { params: m[1] ?? "", value: m[2] } : null;
    };
    const uid = field("UID")?.value.trim();
    const summary = field("SUMMARY")?.value;
    const start = field("DTSTART");
    if (!uid || !summary || !start) continue;
    if (/^CANCELLED$/i.test(field("STATUS")?.value.trim() ?? "")) continue;
    const s = icsDate(start.value);
    if (!s) continue;
    const endField = field("DTEND");
    const e = endField ? icsDate(endField.value) : null;
    const zoneOf = (params: string) => /TZID=([^;:]+)/.exec(params)?.[1] ?? feedTz;
    const location = unescapeText(field("LOCATION")?.value ?? "").replace(/^[-\s]+|[-\s]+$/g, "").replace(/\s{2,}/g, " ");
    const base = {
      id: `${idPrefix}${uid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}`,
      status: "confirmed",
      summary: unescapeText(summary),
      ...(location ? { location } : {}),
    };
    if (s.date) {
      // The township feed repeats the start day as DTEND; treat that as a one-day event.
      const endDate = e?.date && e.date > s.date ? e.date : addDays(s.date, 1);
      out.push({ ...base, start: { date: s.date }, end: { date: endDate } });
      continue;
    }
    const toIso = (d: { local?: string; utc?: boolean }, params: string) =>
      d.utc ? `${d.local}Z` : zonedIso(d.local!, zoneOf(params));
    const startIso = toIso(s, start.params);
    let endIso = e?.local ? toIso(e, endField!.params) : startIso;
    // Meetings come with an end of 23:59:59; show those as starting at a time only.
    if (/T23:59:59/.test(e?.local ?? "")) endIso = startIso;
    out.push({ ...base, start: { dateTime: startIso }, end: { dateTime: endIso } });
  }
  return out;
}
