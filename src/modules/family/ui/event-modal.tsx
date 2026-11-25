"use client";

import { useState, useTransition } from "react";
import { ErrorNote, Modal, field, tap } from "./kit";

/** Matches EventInput in the calendar module (household wall-clock time). */
export type EventFormValue = {
  title: string;
  location?: string | null;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime?: string | null;
  endTime?: string | null;
};
export type EditableEventView = EventFormValue & { id: string; recurring: boolean };

type Result = { error: string | null };
export type EventActions = {
  create: (input: EventFormValue) => Promise<Result>;
  update: (input: EventFormValue & { id: string }) => Promise<Result>;
  remove: (input: { id: string }) => Promise<Result>;
};

const START_PRESETS = ["08:00", "09:00", "12:00", "15:00", "17:00", "18:00", "19:00"];
const DURATIONS = [
  [30, "30 min"],
  [60, "1 hr"],
  [90, "1½ hr"],
  [120, "2 hr"],
  [180, "3 hr"],
] as const;

function addDaysIso(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function timeLabel(t: string) {
  const h = Number(t.slice(0, 2));
  const m = t.slice(3, 5);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m === "00" ? "" : `:${m}`} ${h < 12 ? "AM" : "PM"}`;
}

function dayChip(iso: string, today: string) {
  if (iso === today) return "Today";
  if (iso === addDaysIso(today, 1)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", day: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
}

/** Start + duration → end date and time (an evening event may run past midnight). */
function endFrom(startDate: string, startTime: string, minutes: number) {
  const total = toMin(startTime) + minutes;
  return { endDate: addDaysIso(startDate, Math.floor(total / 1440)), endTime: fromMin(total % 1440) };
}

/**
 * Add or edit an event on the family Google calendar. Built for a finger on
 * the kitchen screen: day chips for the next week, start-time and length
 * presets, and native pickers for anything else. Deleting asks for a second
 * tap instead of a browser dialog (which would freeze a kiosk browser).
 */
export function EventModal({
  today,
  initial,
  calendarLabel,
  actions,
  onClose,
}: {
  today: string;
  initial?: EditableEventView;
  calendarLabel: string;
  actions: EventActions;
  onClose: () => void;
}) {
  const [v, setV] = useState<EventFormValue>(
    initial ?? { title: "", location: "", allDay: false, startDate: today, endDate: today, startTime: "09:00", endTime: "10:00" },
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const set = (patch: Partial<EventFormValue>) => setV((cur) => ({ ...cur, ...patch }));
  const minutes =
    v.startTime && v.endTime ? (Date.parse(`${v.endDate}T${v.endTime}:00Z`) - Date.parse(`${v.startDate}T${v.startTime}:00Z`)) / 60_000 : 60;

  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      setError(null);
      try {
        const r = await fn();
        if (r.error) setError(r.error);
        else onClose();
      } catch {
        setError("That didn't save. Try again.");
      }
    });

  const save = () => {
    if (!v.title.trim()) return setError("Give the event a name.");
    const body: EventFormValue = { ...v, title: v.title.trim(), location: v.location?.trim() || null };
    if (body.allDay) Object.assign(body, { startTime: null, endTime: null });
    run(() => (initial ? actions.update({ ...body, id: initial.id }) : actions.create(body)));
  };

  const setStartDate = (startDate: string) => {
    if (!startDate) return;
    if (v.allDay) {
      const span = Math.max(0, (Date.parse(v.endDate) - Date.parse(v.startDate)) / 86_400_000);
      set({ startDate, endDate: addDaysIso(startDate, span) });
    } else {
      set({ startDate, ...endFrom(startDate, v.startTime ?? "09:00", Math.max(minutes, 15)) });
    }
  };

  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(today, i));
  const chip = (on: boolean) => `${tap} border ${on ? "border-sky-600 bg-sky-600 text-white" : "border-slate-300 dark:border-slate-600"}`;

  return (
    <Modal title={initial ? "Edit event" : "Add event"} onClose={onClose}>
      <div className="space-y-4">
        <input
          autoFocus={!initial}
          value={v.title}
          onChange={(e) => set({ title: e.target.value })}
          maxLength={120}
          placeholder="What's happening?"
          className={`${field} w-full text-lg`}
        />

        <div>
          <div className="mb-1 text-sm font-semibold opacity-70">Day</div>
          <div className="flex flex-wrap gap-2">
            {days.map((d) => (
              <button key={d} type="button" className={chip(v.startDate === d)} onClick={() => setStartDate(d)}>
                {dayChip(d, today)}
              </button>
            ))}
            <input type="date" value={v.startDate} onChange={(e) => setStartDate(e.target.value)} className={field} aria-label="Pick a date" />
          </div>
        </div>

        <label className="flex min-h-12 items-center gap-3 text-lg">
          <input
            type="checkbox"
            className="h-7 w-7"
            checked={v.allDay}
            onChange={(e) =>
              e.target.checked
                ? set({ allDay: true, endDate: v.endDate < v.startDate ? v.startDate : v.endDate })
                : set({ allDay: false, startTime: v.startTime ?? "09:00", ...endFrom(v.startDate, v.startTime ?? "09:00", 60) })
            }
          />
          All day
        </label>

        {v.allDay ? (
          <label className="flex items-center gap-3">
            <span className="text-sm font-semibold opacity-70">Last day</span>
            <input
              type="date"
              min={v.startDate}
              value={v.endDate}
              onChange={(e) => e.target.value && set({ endDate: e.target.value })}
              className={field}
            />
          </label>
        ) : (
          <>
            <div>
              <div className="mb-1 text-sm font-semibold opacity-70">Starts</div>
              <div className="flex flex-wrap gap-2">
                {START_PRESETS.map((t) => (
                  <button key={t} type="button" className={chip(v.startTime === t)} onClick={() => set({ startTime: t, ...endFrom(v.startDate, t, Math.max(minutes, 15)) })}>
                    {timeLabel(t)}
                  </button>
                ))}
                <input
                  type="time"
                  step={300}
                  value={v.startTime ?? ""}
                  onChange={(e) => e.target.value && set({ startTime: e.target.value, ...endFrom(v.startDate, e.target.value, Math.max(minutes, 15)) })}
                  className={field}
                  aria-label="Start time"
                />
              </div>
            </div>
            <div>
              <div className="mb-1 text-sm font-semibold opacity-70">How long</div>
              <div className="flex flex-wrap gap-2">
                {DURATIONS.map(([m, label]) => (
                  <button key={m} type="button" className={chip(minutes === m)} onClick={() => set(endFrom(v.startDate, v.startTime ?? "09:00", m))}>
                    {label}
                  </button>
                ))}
                <label className="flex items-center gap-2">
                  <span className="text-sm opacity-70">ends</span>
                  <input
                    type="time"
                    step={300}
                    value={v.endTime ?? ""}
                    onChange={(e) => {
                      const t = e.target.value;
                      if (!t || !v.startTime) return;
                      set({ endTime: t, endDate: toMin(t) <= toMin(v.startTime) ? addDaysIso(v.startDate, 1) : v.startDate });
                    }}
                    className={field}
                    aria-label="End time"
                  />
                </label>
              </div>
            </div>
          </>
        )}

        <input
          value={v.location ?? ""}
          onChange={(e) => set({ location: e.target.value })}
          maxLength={120}
          placeholder="Where (optional)"
          className={`${field} w-full`}
        />

        {initial?.recurring ? <p className="text-sm opacity-70">This is one day of a repeating event. Changes apply to this day only.</p> : null}
        <p className="text-sm opacity-60">Saves to the {calendarLabel} Google calendar.</p>
        <ErrorNote error={error} />

        <div className="flex gap-2">
          {initial ? (
            confirmDelete ? (
              <button type="button" disabled={pending} className={`${tap} bg-red-600 text-white`} onClick={() => run(() => actions.remove({ id: initial.id }))}>
                Tap again to delete
              </button>
            ) : (
              <button type="button" disabled={pending} className={`${tap} border border-red-400 text-red-600`} onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )
          ) : null}
          <button type="button" disabled={pending} onClick={save} className={`${tap} ml-auto flex-1 bg-sky-600 text-lg text-white`}>
            {pending ? "Saving…" : initial ? "Save" : "Add event"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
