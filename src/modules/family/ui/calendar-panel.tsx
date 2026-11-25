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

type View = "agenda" | "week" | "month";
type OnEdit = (e: EditableEventView) => void;
type OnDay = (d: AgendaDayView) => void;

/**
 * Left side of the kiosk, colour-coded per calendar. Three views:
 * - Week (default): one column per day from today, as many as fit the panel
 *   (columns keep their width when the panel is resized); swipe or drag
 *   sideways, or use the arrows, to see later weeks.
 * - Month: the whole month on a grid, with arrows to the next month.
 * - Next 4 days: today large, then the next three days.
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
  const allDays = [...earlier, ...days];
  const dayOpen = openDay ? allDays.find((d) => d.date === openDay) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border p-0.5 sm:p-1">
          {(["week", "month", "agenda"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`${tap} max-sm:px-2.5 ${view === v ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : ""}`}
            >
              {v === "agenda" ? "4 days" : v === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
        <div className="order-last flex w-full flex-wrap gap-2 sm:order-none sm:w-auto sm:flex-1">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1 rounded-full px-3 py-1 text-sm font-semibold" style={{ background: `${l.color}22`, color: l.color }}>
              <span className="h-3 w-3 rounded-full" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
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

      {view === "agenda" ? (
        <Agenda days={days.slice(0, 4)} onEdit={onEdit} onDay={onDay} />
      ) : view === "week" ? (
        <WeekStrip days={days} onEdit={onEdit} onDay={onDay} />
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

function Agenda({ days, onEdit, onDay }: { days: AgendaDayView[]; onEdit: OnEdit; onDay: OnDay }) {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[2fr_1fr_1fr_1fr] gap-2">
      {days.map((d) => (
        <section key={d.date} className={`flex min-h-0 flex-col rounded-xl p-2 ${d.isToday ? "bg-sky-50 ring-2 ring-sky-400 dark:bg-sky-950" : "bg-slate-100 dark:bg-slate-800"}`}>
          <DayHeader d={d} onDay={onDay} size={d.isToday ? "lg" : "md"} />
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
            {d.items.length === 0 ? <p className="opacity-50">Nothing planned</p> : d.items.map((e) => <EventCard key={e.key} e={e} onEdit={onEdit} />)}
          </div>
        </section>
      ))}
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
