"use client";

import { useState, useTransition } from "react";
import { EventCard, type AgendaDayView } from "./calendar-panel";
import { EventModal, type EditableEventView, type EventActions } from "./event-modal";
import { tap } from "./kit";

/** Phone calendar tab: the next 7 days as a list, with add / edit / delete on the family calendar. */
export function PhoneCalendar({
  days,
  today,
  writableLabel,
  configured,
  syncError,
  actions,
  sync,
}: {
  days: AgendaDayView[];
  today: string;
  writableLabel: string | null;
  configured: boolean;
  syncError: string | null;
  actions: EventActions;
  sync: () => Promise<{ ok: boolean; message: string | null }>;
}) {
  const [modal, setModal] = useState<{ edit?: EditableEventView } | null>(null);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex gap-2">
        <button type="button" disabled={!writableLabel} onClick={() => setModal({})} className={`${tap} flex-1 bg-sky-600 text-white disabled:opacity-40`}>
          + Add Event
        </button>
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
        >
          <span className={pending ? "inline-block animate-spin" : ""}>⟳</span> Sync
        </button>
      </div>
      {!configured ? (
        <p className="rounded-lg bg-amber-100 p-2 text-sm text-amber-900">Google Calendar isn&apos;t connected yet. Showing household events only.</p>
      ) : message || syncError ? (
        <p className="rounded-lg bg-red-100 p-2 text-sm text-red-900">Calendar sync problem: {message ?? syncError}</p>
      ) : null}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pb-6">
        {days.map((d) => (
          <section key={d.date}>
            <h3 className={`sticky top-0 bg-white/90 py-1 font-bold dark:bg-slate-950/90 ${d.isToday ? "text-sky-600" : ""}`}>{d.label}</h3>
            <div className="space-y-1">
              {d.items.length === 0 ? <p className="text-sm opacity-50">Nothing planned</p> : null}
              {d.items.map((e) => (
                <EventCard key={e.key} e={e} compact onEdit={(edit) => setModal({ edit })} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {modal && writableLabel ? (
        <EventModal today={today} initial={modal.edit} calendarLabel={writableLabel} actions={actions} onClose={() => setModal(null)} />
      ) : null}
    </div>
  );
}
