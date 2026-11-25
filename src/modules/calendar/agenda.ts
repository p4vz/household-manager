import { addDays, zonedMidnight } from "@/core/time/zoned";
import { toEventInput, type EventInput } from "./google-config";

/**
 * Builds the kiosk's day-by-day agenda from stored Google events and the
 * household's own calendar events (trips and other entries). Pure, so it is
 * unit tested; all labels are made on the server in the household time zone.
 */
export type AgendaItem = {
  key: string;
  title: string;
  location: string | null;
  /** "All day", "9:00 – 10:30 AM", or "Until 3:00 PM" on later days of a long event. */
  timeLabel: string;
  allDay: boolean;
  color: string;
  who: string;
  sortKey: number;
  /** Set for events on the family calendar: the values the edit form starts from. */
  edit?: EditableEvent;
};

export type EditableEvent = EventInput & { id: string; recurring: boolean };

export type AgendaDay = { date: string; label: string; isToday: boolean; items: AgendaItem[] };

export type GoogleRow = {
  id: string;
  calendarKey: string;
  title: string;
  location: string | null;
  allDay: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  startDate: string | null;
  endDate: string | null;
  recurring?: boolean;
};

export type HouseholdRow = {
  id: string;
  title: string;
  startDate: string;
  endDate: string | null;
  sourceModule: string | null;
};

export type SourceStyle = { key: string; label: string; color: string; writable?: boolean };

export const HOUSEHOLD_STYLE = { label: "Household", color: "#7c3aed" };

function timeFmt(tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

/** "9:00 – 10:30 AM", "11:30 AM – 1:00 PM". */
export function timeRangeLabel(start: Date, end: Date, tz: string): string {
  const f = timeFmt(tz);
  const a = f.format(start);
  const b = f.format(end);
  const [aTime, aPeriod] = a.split(" ");
  const [, bPeriod] = b.split(" ");
  if (start.getTime() === end.getTime()) return a;
  return aPeriod === bPeriod ? `${aTime} – ${b}` : `${a} – ${b}`;
}

export function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function buildAgenda(input: {
  today: string;
  days: number;
  tz: string;
  google: GoogleRow[];
  household: HouseholdRow[];
  sources: SourceStyle[];
}): AgendaDay[] {
  const { today, tz } = input;
  const style = new Map(input.sources.map((s) => [s.key, s]));
  const out: AgendaDay[] = [];
  const f = timeFmt(tz);

  for (let i = 0; i < input.days; i++) {
    const date = addDays(today, i);
    const dayStart = zonedMidnight(date, tz);
    const dayEnd = zonedMidnight(addDays(date, 1), tz);
    const items: AgendaItem[] = [];

    for (const e of input.google) {
      const s = style.get(e.calendarKey);
      if (!s) continue;
      const edit = s.writable ? { id: e.id, recurring: Boolean(e.recurring), ...toEventInput(e, tz) } : undefined;
      if (e.allDay) {
        if (!e.startDate || e.startDate > date || (e.endDate ?? addDays(e.startDate, 1)) <= date) continue;
        items.push({ key: `g:${e.id}:${date}`, title: e.title, location: e.location, timeLabel: "All day", allDay: true, color: s.color, who: s.label, sortKey: 0, edit });
        continue;
      }
      if (!e.startsAt) continue;
      const end = e.endsAt ?? e.startsAt;
      const overlaps = e.startsAt < dayEnd && (end > dayStart || e.startsAt.getTime() === end.getTime() && e.startsAt >= dayStart);
      if (!overlaps) continue;
      const startsToday = e.startsAt >= dayStart;
      const endsToday = end <= dayEnd;
      const timeLabel = startsToday && endsToday
        ? timeRangeLabel(e.startsAt, end, tz)
        : startsToday
          ? `From ${f.format(e.startsAt)}`
          : endsToday
            ? `Until ${f.format(end)}`
            : "All day";
      items.push({
        key: `g:${e.id}:${date}`,
        title: e.title,
        location: e.location,
        timeLabel,
        allDay: !startsToday && !endsToday,
        color: s.color,
        who: s.label,
        sortKey: startsToday ? e.startsAt.getTime() : 1,
        edit,
      });
    }

    for (const e of input.household) {
      const last = e.endDate ?? e.startDate;
      if (e.startDate > date || last < date) continue;
      items.push({
        key: `h:${e.id}:${date}`,
        title: e.title,
        location: null,
        timeLabel: "All day",
        allDay: true,
        color: HOUSEHOLD_STYLE.color,
        who: HOUSEHOLD_STYLE.label,
        sortKey: 0,
      });
    }

    items.sort((a, b) => a.sortKey - b.sortKey || a.title.localeCompare(b.title));
    out.push({ date, label: dayLabel(date, today), isToday: date === today, items });
  }
  return out;
}
