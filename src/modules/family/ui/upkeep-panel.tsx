"use client";

import { startTransition, useOptimistic, useState } from "react";
import { ErrorNote, Modal, field, messageOf, tap } from "./kit";

export type UpkeepView = {
  id: string;
  title: string;
  dueDate: string;
  dueLabel: string;
  overdue: boolean;
  repeatLabel: string | null;
  notes: string | null;
  /** A one-time house to-do: `dueLabel` is the day it was added. */
  todo?: boolean;
  assignee?: string | null;
};

type Result = { error: string | null };
export type UpkeepActions = {
  complete?: (input: { taskId: string }) => Promise<void>;
  /** Adult mode: add a one-time house to-do. */
  add?: (input: { title: string; assignee?: string }) => Promise<Result>;
  /** Adult mode: hide a to-do or task until a day. */
  defer?: (input: { taskId: string; until: string }) => Promise<Result>;
};

function addDays(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Upcoming and overdue house upkeep from the maintenance module, plus the
 * one-time house to-dos. Ticking one marks it done today; a repeating task
 * comes back on its next date. Without the actions (the kitchen screen
 * outside adult mode, which kids use) the list is read-only.
 */
export function UpkeepPanel({
  tasks,
  complete,
  add,
  defer,
  people = [],
  today,
}: { tasks: UpkeepView[]; people?: string[]; today?: string } & UpkeepActions) {
  const [list, remove] = useOptimistic(tasks, (state, id: string) => state.filter((t) => t.id !== id));
  const [confirm, setConfirm] = useState<UpkeepView | null>(null);
  const [deferring, setDeferring] = useState<UpkeepView | null>(null);
  const [adding, setAdding] = useState(false);
  const day = today ?? new Date().toISOString().slice(0, 10);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {add ? (
        <button type="button" onClick={() => setAdding(true)} className={`${tap} shrink-0 self-start border-2 border-dashed`}>
          + House to-do
        </button>
      ) : null}
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
        {list.length === 0 ? <li className="p-4 text-center opacity-60">Nothing due in the next two weeks.</li> : null}
        {list.map((t) => (
          <li
            key={t.id}
            className={`flex items-center gap-2 rounded-xl border-2 p-2 ${t.overdue ? "border-red-500 bg-red-50 dark:bg-red-950" : "border-slate-200 dark:border-slate-700"}`}
          >
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-lg font-semibold leading-snug">
                {t.todo ? "🏠" : "🔧"} {t.title}
              </div>
              <div className={`text-sm ${t.overdue ? "font-semibold text-red-700 dark:text-red-300" : "opacity-80"}`}>
                {t.todo ? t.dueLabel : `Due ${t.dueLabel}`}
                {t.assignee ? <span> · {t.assignee}</span> : null}
                {t.repeatLabel ? <span className="opacity-70"> · {t.repeatLabel}</span> : null}
              </div>
            </div>
            {defer ? (
              <button type="button" onClick={() => setDeferring(t)} className={`${tap} shrink-0 border px-3`}>
                Defer
              </button>
            ) : null}
            {complete ? (
              <button type="button" onClick={() => setConfirm(t)} className={`${tap} shrink-0 bg-emerald-600 text-white`}>
                Done
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {confirm && complete ? (
        <Modal title="Mark as done today?" onClose={() => setConfirm(null)}>
          <p className="mb-2 text-lg">{confirm.title}</p>
          {confirm.repeatLabel ? <p className="mb-4 text-sm opacity-70">The next one is scheduled automatically ({confirm.repeatLabel}).</p> : null}
          <div className="flex gap-3">
            <button
              type="button"
              className={`${tap} flex-1 bg-emerald-600 text-white`}
              onClick={() => {
                const id = confirm.id;
                setConfirm(null);
                startTransition(async () => {
                  remove(id);
                  await complete({ taskId: id });
                });
              }}
            >
              Done
            </button>
            <button type="button" className={`${tap} flex-1 border`} onClick={() => setConfirm(null)}>
              Not yet
            </button>
          </div>
        </Modal>
      ) : null}
      {deferring && defer ? (
        <DeferModal task={deferring} today={day} defer={defer} onClose={() => setDeferring(null)} onDeferred={(id) => startTransition(() => remove(id))} />
      ) : null}
      {adding && add ? <AddTodoModal people={people} add={add} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function DeferModal({
  task,
  today,
  defer,
  onClose,
  onDeferred,
}: {
  task: UpkeepView;
  today: string;
  defer: NonNullable<UpkeepActions["defer"]>;
  onClose: () => void;
  onDeferred: (id: string) => void;
}) {
  const [until, setUntil] = useState(addDays(today, 7));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const quick: [string, number][] = [
    ["Tomorrow", 1],
    ["1 week", 7],
    ["2 weeks", 14],
    ["1 month", 30],
  ];
  async function save(day: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await defer({ taskId: task.id, until: day });
      if (r.error) return setError(r.error);
      onDeferred(task.id);
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Defer until" onClose={onClose}>
      <p className="mb-3 text-lg">{task.title}</p>
      <p className="mb-3 text-sm opacity-70">It disappears from this list and comes back on that day.</p>
      <div className="mb-3 grid grid-cols-2 gap-2">
        {quick.map(([label, n]) => (
          <button key={label} type="button" disabled={busy} className={`${tap} border`} onClick={() => save(addDays(today, n))}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="date"
          aria-label="Defer until"
          className={`${field} min-w-0 flex-1`}
          value={until}
          min={addDays(today, 1)}
          onChange={(e) => setUntil(e.target.value)}
        />
        <button type="button" disabled={busy || !until} className={`${tap} bg-sky-600 text-white`} onClick={() => save(until)}>
          Defer
        </button>
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}

function AddTodoModal({ people, add, onClose }: { people: string[]; add: NonNullable<UpkeepActions["add"]>; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [who, setWho] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await add({ title, assignee: who || undefined });
      if (r.error) return setError(r.error);
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="New house to-do" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void save();
        }}
      >
        <input className={field} placeholder="What needs doing?" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <div>
          <div className="mb-1 text-sm opacity-70">Who will do it</div>
          {people.length ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {people.map((p) => (
                <button key={p} type="button" onClick={() => setWho(who === p ? "" : p)} className={`${tap} border-2 ${who === p ? "border-sky-600 bg-sky-50 dark:bg-sky-950" : ""}`}>
                  {p}
                </button>
              ))}
            </div>
          ) : null}
          <input className={`${field} w-full`} placeholder="Name" value={who} maxLength={40} onChange={(e) => setWho(e.target.value)} />
        </div>
        <p className="text-sm opacity-70">Dated today. It stays on the Upkeep list until it is done.</p>
        <ErrorNote error={error} />
        <div className="flex gap-3">
          <button type="submit" disabled={busy || !title.trim()} className={`${tap} flex-1 bg-emerald-600 text-white disabled:opacity-50`}>
            Add
          </button>
          <button type="button" className={`${tap} flex-1 border`} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
