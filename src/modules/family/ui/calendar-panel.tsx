"use client";

import { useState, useTransition } from "react";
import { EventModal, type EditableEventView, type EventActions } from "./event-modal";
import { tap } from "./kit";

export type AgendaItemView = {
  key: string;
  title: string;
  location: string | null;
  timeLabel: string;
  allDay: boolean;
  color: string;
  who: string;
  /** Present for events on the family calendar, which can be edited here. */
  edit?: EditableEventView;
};
export type AgendaDayView = { date: string; label: string; isToday: boolean; items: AgendaItemView[] };

/**
 * Left side of the kiosk: Today + next 3 days (default) or a 7-day week
 * grid, colour-coded per calendar. "+ Add Event" and a tap on a family
 * calendar event open the event modal, which writes to Google straight away.
 * A Sync button sits next to the background refresh.
 */
export function CalendarPanel({
  days,
  legend,
  configured,
  syncedLabel,
  syncError,
  sync,
  today,
  writableLabel,
  eventActions,
}: {
  days: AgendaDayView[];
  legend: { label: string; color: string }[];
  configured: boolean;
  syncedLabel: string | null;
  syncError: string | null;
  sync: () => Promise<{ ok: boolean; message: string | null }>;
  today: string;
  writableLabel: string | null;
  eventActions: EventActions;
}) {
  const [view, setView] = useState<"agenda" | "week">("agenda");
  const [modal, setModal] = useState<{ edit?: EditableEventView } | null>(null);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border p-1">
          {(["agenda", "week"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`${tap} ${view === v ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : ""}`}
            >
              {v === "agenda" ? "Next 4 days" : "Week"}
            </button>
          ))}
        </div>
        <div className="flex flex-1 flex-wrap gap-2">
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
          <span className={pending ? "inline-block animate-spin" : ""}>⟳</span> {pending ? "Syncing" : "Sync"}
        </button>
        <button
          type="button"
          disabled={!writableLabel}
          onClick={() => setModal({})}
          className={`${tap} bg-sky-600 text-lg text-white disabled:opacity-40`}
        >
          + Add Event
        </button>
      </div>
      {!configured ? (
        <p className="rounded-lg bg-amber-100 p-2 text-sm text-amber-900">Google Calendar isn&apos;t connected yet. Showing household events only.</p>
      ) : message || syncError ? (
        <p className="rounded-lg bg-red-100 p-2 text-sm text-red-900">Calendar sync problem: {message ?? syncError}</p>
      ) : null}

      {view === "agenda" ? <Agenda days={days.slice(0, 4)} onEdit={(edit) => setModal({ edit })} /> : <WeekGrid days={days.slice(0, 7)} onEdit={(edit) => setModal({ edit })} />}
      {syncedLabel ? <p className="text-xs opacity-50">Synced {syncedLabel}</p> : null}
      {modal && writableLabel ? (
        <EventModal today={today} initial={modal.edit} calendarLabel={writableLabel} actions={eventActions} onClose={() => setModal(null)} />
      ) : null}
    </div>
  );
}

type OnEdit = (e: EditableEventView) => void;

export function EventCard({ e, compact = false, onEdit }: { e: AgendaItemView; compact?: boolean; onEdit?: OnEdit }) {
  const edit = e.edit;
  const Tag = edit && onEdit ? "button" : "div";
  return (
    <Tag
      {...(edit && onEdit ? { type: "button" as const, onClick: () => onEdit(edit), "aria-label": `Edit ${e.title}` } : {})}
      className={`block w-full rounded-lg border-l-8 bg-white text-left dark:bg-slate-900 ${compact ? "p-1.5" : "min-h-12 p-2"} ${edit && onEdit ? "active:scale-[0.98]" : ""}`}
      style={{ borderColor: e.color }}
    >
      <div className={`flex items-baseline gap-2 ${compact ? "flex-col gap-0" : ""}`}>
        <span className={`shrink-0 font-semibold tabular-nums ${compact ? "text-xs" : "w-40 text-base"}`} style={{ color: e.color }}>
          {e.timeLabel}
        </span>
        <span className={`min-w-0 font-semibold leading-tight ${compact ? "text-sm" : "text-lg"}`}>{e.title}</span>
      </div>
      {e.location && !compact ? <div className="truncate pl-[10.5rem] text-sm opacity-70">📍 {e.location}</div> : null}
      {e.location && compact ? <div className="truncate text-xs opacity-70">📍 {e.location}</div> : null}
    </Tag>
  );
}

function Agenda({ days, onEdit }: { days: AgendaDayView[]; onEdit: OnEdit }) {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[2fr_1fr_1fr_1fr] gap-2">
      {days.map((d) => (
        <section key={d.date} className={`flex min-h-0 flex-col rounded-xl p-2 ${d.isToday ? "bg-sky-50 ring-2 ring-sky-400 dark:bg-sky-950" : "bg-slate-100 dark:bg-slate-800"}`}>
          <h3 className={`mb-1 font-bold ${d.isToday ? "text-2xl" : "text-lg"}`}>{d.label}</h3>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
            {d.items.length === 0 ? <p className="opacity-50">Nothing planned</p> : d.items.map((e) => <EventCard key={e.key} e={e} onEdit={onEdit} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function WeekGrid({ days, onEdit }: { days: AgendaDayView[]; onEdit: OnEdit }) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-7 gap-1.5">
      {days.map((d) => (
        <section key={d.date} className={`flex min-h-0 flex-col rounded-xl p-1.5 ${d.isToday ? "bg-sky-50 ring-2 ring-sky-400 dark:bg-sky-950" : "bg-slate-100 dark:bg-slate-800"}`}>
          <h3 className="mb-1 text-center text-sm font-bold leading-tight">{d.label}</h3>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
            {d.items.map((e) => (
              <EventCard key={e.key} e={e} compact onEdit={onEdit} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
