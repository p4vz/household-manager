"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Modal, field, tap } from "./kit";

export type ChoreLogEntryView = { id: string; day: string; choreId: string; title: string; icon: string; recurrence: "daily" | "weekly" | "once"; stars: number };

export type ChoreLogActions = {
  list: (input: { kidId: string }) => Promise<{ today: string; entries: ChoreLogEntryView[] }>;
  /** Adult mode or a parent only. */
  add?: (input: { choreId: string; day: string }) => Promise<{ error: string | null; added: boolean }>;
  remove?: (input: { id: string }) => Promise<void>;
};

const shortDate = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function dayLabel(day: string, today: string) {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return shortDate(day);
}

/**
 * A kid's chore log: done chores, day by day, newest first, with their
 * stars. Anyone can look. In adult mode a missed chore can be added for an
 * earlier day and a wrong one taken off (its stars go with it).
 */
export function ChoreLogModal({
  kidId,
  kidName,
  chores,
  actions,
  onClose,
}: {
  kidId: string;
  kidName: string;
  chores: { id: string; title: string; icon: string }[];
  actions: ChoreLogActions;
  onClose: () => void;
}) {
  const [log, setLog] = useState<{ today: string; entries: ChoreLogEntryView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [choreId, setChoreId] = useState(chores[0]?.id ?? "");
  const [day, setDay] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const edit = Boolean(actions.add && actions.remove);

  const reload = useCallback(async () => {
    try {
      const r = await actions.list({ kidId });
      setLog(r);
      setDay((d) => d || addDays(r.today, -1));
    } catch {
      setError("Couldn't load the chore log.");
    }
  }, [actions, kidId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once when the log opens
    void reload();
  }, [reload]);

  const days = new Map<string, ChoreLogEntryView[]>();
  for (const e of log?.entries ?? []) days.set(e.day, [...(days.get(e.day) ?? []), e]);

  return (
    <Modal title={`✅ ${kidName}'s chore log`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm opacity-70">The last 60 days. Weekly chores show under the Monday of their week.</p>
        {edit && log ? (
          <div className="space-y-2 rounded-xl border border-sky-300 bg-sky-50 p-3">
            <div className="text-sm font-semibold">Add a chore that was done but not ticked</div>
            <div className="flex flex-wrap gap-2">
              <select className={`${field} min-w-0 flex-1`} value={choreId} onChange={(e) => setChoreId(e.target.value)} aria-label="Chore">
                {chores.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon} {c.title}
                  </option>
                ))}
              </select>
              <input type="date" className={field} value={day} min={addDays(log.today, -60)} max={log.today} onChange={(e) => setDay(e.target.value)} aria-label="Day" />
              <button
                type="button"
                disabled={pending || !choreId || !day}
                className={`${tap} bg-sky-600 text-white disabled:opacity-50`}
                onClick={() =>
                  start(async () => {
                    const r = await actions.add!({ choreId, day });
                    setError(r.error);
                    await reload();
                  })
                }
              >
                ＋ Add
              </button>
            </div>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        {!log ? <p className="text-sm opacity-60">Loading…</p> : days.size === 0 ? <p className="text-sm opacity-60">No chores done in the last 60 days.</p> : null}
        <ul className="max-h-[55vh] space-y-2 overflow-auto">
          {[...days.entries()].map(([d, list]) => (
            <li key={d} className="rounded-xl border border-slate-200 px-3 py-2">
              <div className="flex items-center justify-between text-sm font-semibold">
                <span>{log ? dayLabel(d, log.today) : d}</span>
                <span className="opacity-70">+{list.reduce((s, e) => s + e.stars, 0)} ⭐</span>
              </div>
              {list.map((e) => (
                <div key={e.id} className="flex min-h-10 items-center gap-2 text-sm">
                  <span className="text-lg">{e.icon}</span>
                  <span className="min-w-0 flex-1">
                    {e.title}
                    {e.recurrence === "weekly" ? <span className="ml-1 text-[10px] uppercase opacity-60">week</span> : null}
                  </span>
                  <span className="opacity-70">+{e.stars} ⭐</span>
                  {edit ? (
                    confirm === e.id ? (
                      <button
                        type="button"
                        disabled={pending}
                        className={`${tap} bg-red-600 px-3 text-sm text-white`}
                        onClick={() =>
                          start(async () => {
                            await actions.remove!({ id: e.id });
                            setConfirm(null);
                            await reload();
                          })
                        }
                      >
                        Remove
                      </button>
                    ) : (
                      <button type="button" className={`${tap} px-2 opacity-60`} aria-label={`Remove ${e.title}`} onClick={() => setConfirm(e.id)}>
                        🗑
                      </button>
                    )
                  ) : null}
                </div>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
