"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition, type PointerEvent as ReactPointerEvent } from "react";
import { EventModal, type EditableEventView, type EventActions } from "./event-modal";
import { Modal, tap } from "./kit";

export type AgendaItemView = {
  key: string;
  title: string;
  location: string | null;
  timeLabel: string;
  allDay: boolean;
  color: string;
  who: string;
  notes: string | null;
  photos: number;
  /** Present for events on the family calendar, which can be edited here. */
  edit?: EditableEventView;
};
export type AgendaDayView = {
  date: string;
  label: string;
  /** "Today", "Tomorrow" or the weekday. */
  heading: string;
  /** "November 27". */
  subheading: string;
  isToday: boolean;
  isPast: boolean;
  items: AgendaItemView[];
};

type View = "month" | "week" | "day";
type OnEdit = (e: EditableEventView) => void;
type OnDay = (d: AgendaDayView) => void;

/**
 * Left side of the kiosk, colour-coded per calendar. Three views:
 * - Week (default): one column per day from today, as many as fit the panel
 *   (columns keep their width when the panel is resized); swipe or drag
 *   sideways, or use the arrows, to see later weeks.
 * - Month: the whole month on a grid, with arrows to the next month.
 * - Day: one day in full, with arrows to the days before and after.
 * The calendars sit in a dropdown, where each one can be hidden on this
 * screen (remembered by the browser).
 * Tapping a day header (or a month cell) opens that day in full.
 * "+ Add Event" and a tap on a family calendar event open the event modal,
 * which writes to Google straight away. Deleting is offered only when
 * `eventActions.remove` is given (the signed-in app, never the kiosk).
 * Used full-screen on the kitchen kiosk and on /calendar in the app (phones
 * down to 360 px wide).
 */
export function CalendarPanel({
  days,
  earlier,
  legend,
  configured,
  syncedLabel,
  syncError,
  sync,
  today,
  writableLabel,
  eventActions,
}: {
  /** Today onwards. */
  days: AgendaDayView[];
  /** This month's grid before today (for the month view). */
  earlier: AgendaDayView[];
  legend: { label: string; color: string }[];
  configured: boolean;
  syncedLabel: string | null;
  syncError: string | null;
  sync: () => Promise<{ ok: boolean; message: string | null }>;
  today: string;
  writableLabel: string | null;
  eventActions: EventActions;
}) {
  const [view, setView] = useState<View>("week");
  const [modal, setModal] = useState<{ edit?: EditableEventView; day?: string } | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const onEdit: OnEdit = (edit) => setModal({ edit });
  const onDay: OnDay = (d) => setOpenDay(d.date);
  const [hidden, setHidden] = useHiddenCalendars();
  const visible = (list: AgendaDayView[]) => (hidden.size ? list.map((d) => ({ ...d, items: d.items.filter((i) => !hidden.has(i.who)) })) : list);
  const shownDays = visible(days);
  const allDays = visible([...earlier, ...days]);
  const dayOpen = openDay ? allDays.find((d) => d.date === openDay) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border p-0.5 sm:p-1">
          {(["month", "week", "day"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`${tap} max-sm:px-2.5 ${view === v ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : ""}`}
            >
              {v === "day" ? "Day" : v === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
        <CalendarsMenu legend={legend} hidden={hidden} onChange={setHidden} />
        <div className="flex-1 max-sm:hidden" />
        <button
          type="button"
          disabled={pending || !configured}
          onClick={() =>
            start(async () => {
              const r = await sync();
              setMessage(r.ok ? null : (r.message ?? "Sync failed"));
            })
          }
          className={`${tap} border`}
          title={syncedLabel ? `Last synced ${syncedLabel}` : undefined}
        >
          <span className={pending ? "inline-block animate-spin" : ""}>⟳</span>
          <span className="hidden sm:inline"> {pending ? "Syncing" : "Sync"}</span>
        </button>
        <button
          type="button"
          disabled={!writableLabel}
          onClick={() => setModal({})}
          className={`${tap} ml-auto bg-sky-600 text-white max-sm:px-3 disabled:opacity-40 sm:ml-0 sm:text-lg`}
        >
          + Add<span className="hidden sm:inline"> Event</span>
        </button>
      </div>
      {!configured ? (
        <p className="rounded-lg bg-amber-100 p-2 text-sm text-amber-900">Google Calendar isn&apos;t connected yet. Showing household events only.</p>
      ) : message || syncError ? (
        <p className="rounded-lg bg-red-100 p-2 text-sm text-red-900">Calendar sync problem: {message ?? syncError}</p>
      ) : null}

      {view === "day" ? (
        <DayView days={allDays} today={today} onEdit={onEdit} />
      ) : view === "week" ? (
        <WeekStrip days={shownDays} onEdit={onEdit} onDay={onDay} />
      ) : (
        <MonthGrid days={allDays} today={today} onDay={onDay} />
      )}
      {syncedLabel ? <p className="text-xs opacity-50">Synced {syncedLabel}</p> : null}
      {dayOpen ? (
        <DayModal
          day={dayOpen}
          canAdd={Boolean(writableLabel)}
          onEdit={(edit) => setModal({ edit })}
          onAdd={() => setModal({ day: dayOpen.date })}
          onClose={() => setOpenDay(null)}
        />
      ) : null}
      {modal && writableLabel ? (
        <EventModal today={today} initial={modal.edit} day={modal.day} calendarLabel={writableLabel} actions={eventActions} onClose={() => setModal(null)} />
      ) : null}
    </div>
  );
}

/** Google Maps search for an address or place name (opens in a new tab). */
export function mapsUrl(place: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}

/**
 * One event. `details` (the day view) adds the notes and a maps link for
 * the address; elsewhere small marks show that notes or pictures exist.
 */
export function EventCard({ e, compact = false, details = false, onEdit }: { e: AgendaItemView; compact?: boolean; details?: boolean; onEdit?: OnEdit }) {
  const edit = e.edit;
  const editable = Boolean(edit && onEdit);
  const marks = `${e.notes && !details ? " 📝" : ""}${e.photos ? ` 📷${e.photos > 1 ? e.photos : ""}` : ""}`;
  const main = (
    <div className={`flex items-baseline gap-2 ${compact ? "flex-col gap-0" : ""}`}>
      <span className={`shrink-0 font-semibold tabular-nums ${compact ? "text-xs" : "w-28 text-sm sm:w-40 sm:text-base"}`} style={{ color: e.color }}>
        {e.timeLabel}
      </span>
      <span className={`min-w-0 font-semibold leading-tight ${compact ? "text-sm" : "text-base sm:text-lg"}`}>
        {e.title}
        {marks ? <span className="ml-1 whitespace-nowrap text-xs font-normal opacity-70">{marks}</span> : null}
      </span>
    </div>
  );
  const indent = compact ? "" : "pl-[7.5rem] sm:pl-[10.5rem]";
  return (
    <div
      className={`w-full rounded-lg border-l-8 bg-white text-left dark:bg-slate-900 ${compact ? "p-1.5" : "min-h-12 p-2"}`}
      style={{ borderColor: e.color }}
    >
      {editable ? (
        <button type="button" onClick={() => onEdit!(edit!)} aria-label={`Edit ${e.title}`} className="block w-full text-left active:scale-[0.98]">
          {main}
        </button>
      ) : (
        main
      )}
      {e.location ? (
        details ? (
          <a href={mapsUrl(e.location)} target="_blank" rel="noreferrer" className={`block truncate text-sm text-sky-700 underline dark:text-sky-300 ${indent}`}>
            📍 {e.location}
          </a>
        ) : (
          <div className={`truncate opacity-70 ${compact ? "text-xs" : `text-sm ${indent}`}`}>📍 {e.location}</div>
        )
      ) : null}
      {details && e.notes ? <p className={`mt-1 line-clamp-6 whitespace-pre-line text-sm opacity-80 ${indent}`}>{e.notes}</p> : null}
    </div>
  );
}

/** Two-line day header (weekday, then month and day) that opens the day. */
function DayHeader({ d, onDay, size = "md" }: { d: AgendaDayView; onDay: OnDay; size?: "md" | "lg" | "sm" }) {
  const big = size === "lg" ? "text-2xl" : size === "md" ? "text-lg" : "text-base";
  return (
    <button
      type="button"
      onClick={() => onDay(d)}
      aria-label={`Open ${d.heading}, ${d.subheading}`}
      className={`mb-1 block w-full rounded-lg text-left leading-tight active:bg-black/5 ${size === "sm" ? "text-center" : ""}`}
    >
      <span className={`block truncate font-bold ${big} ${d.isToday ? "text-sky-700 dark:text-sky-300" : ""}`}>{d.heading}</span>
      <span className="block truncate text-sm font-medium opacity-70">{d.subheading}</span>
    </button>
  );
}

/** One day in full (events with notes and maps links), with arrows to the days around it. */
function DayView({ days, today, onEdit }: { days: AgendaDayView[]; today: string; onEdit: OnEdit }) {
  const [index, setIndex] = useState(() => Math.max(0, days.findIndex((d) => d.date === today)));
  const d = days[Math.min(index, days.length - 1)];
  if (!d) return <p className="opacity-50">Nothing planned</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" className={`${tap} border px-3`} onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index <= 0} aria-label="Day before">
          ‹
        </button>
        {d.date !== today ? (
          <button type="button" className={`${tap} border`} onClick={() => setIndex(Math.max(0, days.findIndex((x) => x.date === today)))}>
            Today
          </button>
        ) : null}
        <div className="flex-1" />
        <button type="button" className={`${tap} border px-3`} onClick={() => setIndex((i) => Math.min(days.length - 1, i + 1))} disabled={index >= days.length - 1} aria-label="Day after">
          ›
        </button>
      </div>
      <section className={`flex min-h-0 flex-1 flex-col rounded-xl p-3 ${d.isToday ? "bg-sky-50 ring-2 ring-sky-400 dark:bg-sky-950" : "bg-slate-100 dark:bg-slate-800"}`}>
        <div className="mb-2">
          <div className="text-2xl font-bold">{d.heading}</div>
          <div className="text-sm opacity-60">{d.subheading}</div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
          {d.items.length === 0 ? <p className="opacity-50">Nothing planned</p> : d.items.map((e) => <EventCard key={e.key} e={e} details onEdit={onEdit} />)}
        </div>
      </section>
    </div>
  );
}

const HIDDEN_KEY = "kiosk.hiddenCalendars";

/** Calendars hidden on this screen, remembered in the browser (best effort). */
function useHiddenCalendars(): [Set<string>, (next: Set<string>) => void] {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HIDDEN_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount (no localStorage on the server)
      if (raw) setHidden(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* storage off: everything shows */
    }
  }, []);
  const update = (next: Set<string>) => {
    setHidden(next);
    try {
      window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
    } catch {
      /* not remembered */
    }
  };
  return [hidden, update];
}

/** "Calendars ▾": the coloured list of calendars, each with a show/hide tick. */
function CalendarsMenu({ legend, hidden, onChange }: { legend: { label: string; color: string }[]; hidden: Set<string>; onChange: (next: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const shown = legend.filter((l) => !hidden.has(l.label));
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${tap} flex items-center gap-1.5 border`}>
        <span className="flex -space-x-1">
          {shown.slice(0, 5).map((l) => (
            <span key={l.label} className="h-3 w-3 rounded-full ring-2 ring-white dark:ring-slate-900" style={{ background: l.color }} />
          ))}
        </span>
        Calendars{hidden.size ? ` (${shown.length}/${legend.length})` : ""} ▾
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <ul className="absolute left-0 top-full z-40 mt-1 min-w-56 space-y-1 rounded-xl border bg-white p-2 shadow-xl dark:bg-slate-900">
            {legend.map((l) => {
              const on = !hidden.has(l.label);
              return (
                <li key={l.label}>
                  <button
                    type="button"
                    onClick={() => {
                      const next = new Set(hidden);
                      if (on) next.add(l.label);
                      else next.delete(l.label);
                      onChange(next);
                    }}
                    aria-pressed={on}
                    className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-semibold active:bg-slate-100"
                    style={{ color: l.color }}
                  >
                    <span className={`flex h-5 w-5 items-center justify-center rounded border-2 text-xs text-white`} style={{ borderColor: l.color, background: on ? l.color : "transparent" }}>
                      {on ? "✓" : ""}
                    </span>
                    {l.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Narrowest a week column gets before one fewer day is shown. */
const MIN_DAY_WIDTH = 150;

/**
 * Days side by side from today. The number of columns follows the panel's
 * width (never narrower than MIN_DAY_WIDTH), and the strip scrolls sideways
 * day by day: a swipe on touch, a drag with a mouse, or the arrows.
 */
function WeekStrip({ days, onEdit, onDay }: { days: AgendaDayView[]; onEdit: OnEdit; onDay: OnDay }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [first, setFirst] = useState(0);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const perView = Math.max(1, Math.floor((width || MIN_DAY_WIDTH * 7) / MIN_DAY_WIDTH));
  const colWidth = width ? width / perView : MIN_DAY_WIDTH;

  const goTo = useCallback(
    (index: number, smooth = true) => {
      const el = scroller.current;
      if (!el) return;
      const i = Math.max(0, Math.min(days.length - perView, index));
      el.scrollTo({ left: i * colWidth, behavior: smooth ? "smooth" : "auto" });
    },
    [colWidth, days.length, perView],
  );

  // Keep the same first day in view when the columns change width.
  useEffect(() => {
    goTo(first, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colWidth]);

  const onScroll = () => {
    const el = scroller.current;
    if (el && colWidth) setFirst(Math.round(el.scrollLeft / colWidth));
  };

  // Mouse drag to scroll (touch scrolls natively).
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || !scroller.current) return;
    drag.current = { x: e.clientX, left: scroller.current.scrollLeft, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = scroller.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 6) return;
    if (!d.moved) {
      d.moved = true;
      el.style.scrollSnapType = "none";
      el.setPointerCapture(e.pointerId);
    }
    el.scrollLeft = d.left - dx;
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = scroller.current;
    drag.current = null;
    if (!d?.moved || !el) return;
    el.releasePointerCapture?.(e.pointerId);
    el.style.scrollSnapType = "";
    goTo(Math.round(el.scrollLeft / colWidth));
    // Swallow the click that ends a drag so it doesn't open an event.
    const stop = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    el.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => el.removeEventListener("click", stop, { capture: true }), 0);
  };

  const shownFrom = days[Math.min(first, days.length - 1)];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button type="button" className={`${tap} border px-3`} onClick={() => goTo(first - perView)} disabled={first <= 0} aria-label="Earlier days">
          ‹
        </button>
        <button type="button" className={`${tap} border px-3 text-sm`} onClick={() => goTo(0)} disabled={first <= 0}>
          Today
        </button>
        <span className="flex-1 truncate text-center text-sm font-medium opacity-70">
          {first > 0 && shownFrom ? `From ${shownFrom.heading === "Tomorrow" ? "tomorrow" : shownFrom.subheading}` : null}
        </span>
        <button type="button" className={`${tap} border px-3`} onClick={() => goTo(first + perView)} disabled={first + perView >= days.length} aria-label="Later days">
          ›
        </button>
      </div>
      <div
        ref={scroller}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
        data-testid="week-strip"
      >
        {days.map((d) => (
          <div key={d.date} className="h-full shrink-0 snap-start px-[3px]" style={{ width: colWidth }}>
            <section className={`flex h-full min-h-0 flex-col rounded-xl p-1.5 ${d.isToday ? "bg-sky-50 ring-2 ring-inset ring-sky-400 dark:bg-sky-950" : "bg-slate-100 dark:bg-slate-800"}`}>
              <DayHeader d={d} onDay={onDay} size="sm" />
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
                {d.items.map((e) => (
                  <EventCard key={e.key} e={e} compact onEdit={onEdit} />
                ))}
              </div>
            </section>
          </div>
        ))}
      </div>
    </div>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addDaysIso(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "2026-11" + 1 → "2026-12". */
function monthAdd(month: string, n: number) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

/** The whole month on a Sunday-first grid; arrows step through the months the screen has loaded. */
function MonthGrid({ days, today, onDay }: { days: AgendaDayView[]; today: string; onDay: OnDay }) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const lastLoaded = days[days.length - 1]?.date ?? today;
  const [month, setMonth] = useState(today.slice(0, 7));
  const firstOfMonth = `${month}-01`;
  const gridStart = addDaysIso(firstOfMonth, -new Date(`${firstOfMonth}T00:00:00Z`).getUTCDay());
  const nextMonth = monthAdd(month, 1);
  const prevMonth = monthAdd(month, -1);
  const lastOfMonth = addDaysIso(`${nextMonth}-01`, -1);
  const weeks = Math.ceil((Math.round((Date.parse(lastOfMonth) - Date.parse(gridStart)) / 86_400_000) + 1) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => addDaysIso(gridStart, i));
  const title = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${firstOfMonth}T00:00:00Z`));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button type="button" className={`${tap} border px-3`} onClick={() => setMonth(prevMonth)} disabled={month <= today.slice(0, 7)} aria-label="Previous month">
          ‹
        </button>
        <h3 className="flex-1 text-center text-lg font-bold">{title}</h3>
        <button type="button" className={`${tap} border px-3`} onClick={() => setMonth(nextMonth)} disabled={`${nextMonth}-01` > lastLoaded} aria-label="Next month">
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase opacity-60">
        {WEEKDAYS.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 gap-1" style={{ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}>
        {cells.map((date) => {
          const d = byDate.get(date);
          const inMonth = date.slice(0, 7) === month;
          const isToday = date === today;
          const items = d?.items ?? [];
          return (
            <button
              key={date}
              type="button"
              disabled={!d}
              onClick={() => d && onDay(d)}
              aria-label={d ? `Open ${d.heading}, ${d.subheading}` : undefined}
              className={`flex min-h-0 flex-col overflow-hidden rounded-lg p-1 text-left ${
                isToday ? "bg-sky-50 ring-2 ring-inset ring-sky-400 dark:bg-sky-950" : "bg-slate-100 dark:bg-slate-800"
              } ${!inMonth || date < today ? "opacity-50" : ""}`}
            >
              <span className={`text-sm font-bold ${isToday ? "text-sky-700 dark:text-sky-300" : ""}`}>{Number(date.slice(8))}</span>
              <span className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
                {items.slice(0, 3).map((e) => (
                  <span key={e.key} className="hidden truncate rounded px-1 text-xs font-medium leading-5 sm:block" style={{ background: `${e.color}22`, color: e.color }}>
                    {e.title}
                  </span>
                ))}
                {items.length > 3 ? <span className="hidden text-xs opacity-70 sm:block">+{items.length - 3} more</span> : null}
                {/* Phones: a dot per event instead of titles. */}
                {items.length ? (
                  <span className="flex flex-wrap gap-0.5 sm:hidden">
                    {items.slice(0, 4).map((e) => (
                      <span key={e.key} className="h-2 w-2 rounded-full" style={{ background: e.color }} />
                    ))}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One day in full: every event with its time and place, and "Add event" for that day. */
function DayModal({ day, canAdd, onEdit, onAdd, onClose }: { day: AgendaDayView; canAdd: boolean; onEdit: OnEdit; onAdd: () => void; onClose: () => void }) {
  return (
    <Modal title={`${day.heading}, ${day.subheading}`} onClose={onClose}>
      <div className="space-y-2">
        {day.items.length === 0 ? <p className="opacity-60">Nothing planned</p> : null}
        {day.items.map((e) => (
          <EventCard key={e.key} e={e} details onEdit={onEdit} />
        ))}
        {canAdd ? (
          <button type="button" className={`${tap} mt-2 w-full bg-sky-600 text-lg text-white`} onClick={onAdd}>
            + Add event {day.heading === "Today" || day.heading === "Tomorrow" ? day.heading.toLowerCase() : `on ${day.subheading}`}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
