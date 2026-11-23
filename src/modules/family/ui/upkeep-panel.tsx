"use client";

import { startTransition, useOptimistic, useState } from "react";
import { Modal, tap } from "./kit";

export type UpkeepView = { id: string; title: string; dueDate: string; dueLabel: string; overdue: boolean; repeatLabel: string | null; notes: string | null };

/**
 * Upcoming and overdue house upkeep from the maintenance module. Ticking one
 * marks it done today; a repeating task comes back on its next date.
 */
export function UpkeepPanel({ tasks, complete }: { tasks: UpkeepView[]; complete: (input: { taskId: string }) => Promise<void> }) {
  const [list, remove] = useOptimistic(tasks, (state, id: string) => state.filter((t) => t.id !== id));
  const [confirm, setConfirm] = useState<UpkeepView | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
        {list.length === 0 ? <li className="p-4 text-center opacity-60">Nothing due in the next two weeks.</li> : null}
        {list.map((t) => (
          <li
            key={t.id}
            className={`flex items-center gap-3 rounded-xl border-2 p-2 ${t.overdue ? "border-red-500 bg-red-50 dark:bg-red-950" : "border-slate-200 dark:border-slate-700"}`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-semibold">🔧 {t.title}</div>
              <div className={`text-sm ${t.overdue ? "font-semibold text-red-700 dark:text-red-300" : "opacity-80"}`}>
                Due {t.dueLabel}
                {t.repeatLabel ? <span className="opacity-70"> · {t.repeatLabel}</span> : null}
              </div>
            </div>
            <button type="button" onClick={() => setConfirm(t)} className={`${tap} shrink-0 bg-emerald-600 text-white`}>
              Done
            </button>
          </li>
        ))}
      </ul>
      {confirm ? (
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
    </div>
  );
}
