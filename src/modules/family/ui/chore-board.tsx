"use client";

import { startTransition, useOptimistic, useState } from "react";
import { Modal, ProgressBar, field, tap } from "./kit";

export type BoardChoreView = { id: string; title: string; icon: string; recurrence: "daily" | "weekly" | "once"; stars: number; done: boolean };
export type BoardKidView = {
  id: string;
  name: string;
  color: string;
  emoji: string;
  chores: BoardChoreView[];
  stats: { todayDone: number; todayTotal: number; weekPercent: number; streak: number; starsWeek: number; starsTotal: number };
};

type Actions = {
  setDone: (input: { choreId: string; done: boolean }) => Promise<void>;
  addOneTime: (input: { kidId: string; title: string; icon?: string }) => Promise<void>;
};

/**
 * Per-kid columns of big, icon-first chore cards. One tap ticks a chore
 * (checkmark, stars, progress bar move at once); tapping a done chore asks
 * before un-ticking, so a stray tap from a sibling cannot undo it.
 */
export function ChoreBoard({ kids, actions, icons, layout = "kiosk" }: { kids: BoardKidView[]; actions: Actions; icons: readonly string[]; layout?: "kiosk" | "phone" }) {
  const [board, setOptimistic] = useOptimistic(kids, (state, change: { choreId: string; done: boolean }) =>
    state.map((k) => {
      const chores = k.chores.map((c) => (c.id === change.choreId ? { ...c, done: change.done } : c));
      const delta = chores.filter((c) => c.done).length - k.stats.todayDone;
      const starDelta = chores.reduce((s, c) => s + (c.done ? c.stars : 0), 0) - k.chores.reduce((s, c) => s + (c.done ? c.stars : 0), 0);
      return {
        ...k,
        chores,
        stats: { ...k.stats, todayDone: k.stats.todayDone + delta, starsWeek: k.stats.starsWeek + starDelta, starsTotal: k.stats.starsTotal + starDelta },
      };
    }),
  );
  const [confirmUndo, setConfirmUndo] = useState<BoardChoreView | null>(null);
  const [adding, setAdding] = useState(false);

  function set(choreId: string, done: boolean) {
    startTransition(async () => {
      setOptimistic({ choreId, done });
      await actions.setDone({ choreId, done });
    });
  }

  if (kids.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-lg opacity-70">
        Add the kids and their chores from the Family hub page on your phone.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className={`grid min-h-0 flex-1 gap-3 ${layout === "phone" ? "grid-cols-1" : ""}`} style={layout === "kiosk" ? { gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 15rem), 1fr))`, overflowY: "auto" } : undefined}>
        {board.map((kid) => (
          <section key={kid.id} className="flex min-h-0 flex-col rounded-2xl border-4 bg-white p-3 dark:bg-slate-900" style={{ borderColor: kid.color }}>
            <header className="mb-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <h3 className="truncate text-2xl font-bold" style={{ color: kid.color }}>
                  {kid.emoji} {kid.name}
                </h3>
                <span className="shrink-0 text-xl font-bold" aria-label={`${kid.stats.starsWeek} stars this week`}>
                  ⭐ {kid.stats.starsWeek}
                </span>
              </div>
              <ProgressBar value={kid.stats.todayTotal ? kid.stats.todayDone / kid.stats.todayTotal : 0} color={kid.color} />
              <div className="flex justify-between text-sm font-medium opacity-80">
                <span>
                  {kid.stats.todayDone}/{kid.stats.todayTotal} today
                </span>
                <span>🔥 {kid.stats.streak} day{kid.stats.streak === 1 ? "" : "s"}</span>
                <span>{kid.stats.weekPercent}% week</span>
              </div>
            </header>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
              {kid.chores.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => (c.done ? setConfirmUndo(c) : set(c.id, true))}
                    className={`flex min-h-16 w-full items-center gap-3 rounded-xl border-2 px-3 py-2 text-left transition-colors active:scale-[0.98] ${
                      c.done
                        ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950"
                        : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800"
                    }`}
                  >
                    <span className="text-4xl leading-none" aria-hidden>
                      {c.icon}
                    </span>
                    <span className={`flex-1 text-lg font-semibold leading-tight ${c.done ? "line-through opacity-60" : ""}`}>
                      {c.title}
                      {c.recurrence !== "daily" ? (
                        <span className="ml-2 align-middle text-xs font-medium uppercase opacity-60">{c.recurrence === "weekly" ? "this week" : "today"}</span>
                      ) : null}
                    </span>
                    <span
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-4 text-2xl font-black ${
                        c.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300 dark:border-slate-600"
                      }`}
                      aria-label={c.done ? "Done" : "Not done"}
                    >
                      {c.done ? "✓" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <button type="button" onClick={() => setAdding(true)} className={`${tap} self-start border-2 border-dashed border-slate-400`}>
        + One-time chore
      </button>

      {confirmUndo ? (
        <Modal title="Not done after all?" onClose={() => setConfirmUndo(null)}>
          <p className="mb-4 text-lg">
            {confirmUndo.icon} {confirmUndo.title}
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              className={`${tap} flex-1 bg-amber-500 text-white`}
              onClick={() => {
                set(confirmUndo.id, false);
                setConfirmUndo(null);
              }}
            >
              Un-tick it
            </button>
            <button type="button" className={`${tap} flex-1 border`} onClick={() => setConfirmUndo(null)}>
              Keep it done
            </button>
          </div>
        </Modal>
      ) : null}
      {adding ? <AddOneTimeChore kids={board} icons={icons} onClose={() => setAdding(false)} add={actions.addOneTime} /> : null}
    </div>
  );
}

function AddOneTimeChore({
  kids,
  icons,
  onClose,
  add,
}: {
  kids: BoardKidView[];
  icons: readonly string[];
  onClose: () => void;
  add: Actions["addOneTime"];
}) {
  const [kidId, setKidId] = useState(kids[0]?.id ?? "");
  const [icon, setIcon] = useState(icons[0]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Add a one-time chore" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || !kidId) return;
          setBusy(true);
          try {
            await add({ kidId, title: title.trim(), icon });
            onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex flex-wrap gap-2">
          {kids.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKidId(k.id)}
              className={`${tap} border-4 text-lg`}
              style={{ borderColor: kidId === k.id ? k.color : "transparent", background: kidId === k.id ? `${k.color}22` : undefined }}
            >
              {k.emoji} {k.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-8 gap-2">
          {icons.map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIcon(i)}
              className={`h-12 rounded-xl text-3xl ${icon === i ? "bg-sky-200 ring-2 ring-sky-500 dark:bg-sky-900" : "bg-slate-100 dark:bg-slate-800"}`}
            >
              {i}
            </button>
          ))}
        </div>
        <input className={`${field} w-full text-lg`} placeholder="What needs doing?" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <button type="submit" disabled={busy || !title.trim()} className={`${tap} w-full bg-sky-600 text-lg text-white disabled:opacity-50`}>
          Add chore
        </button>
      </form>
    </Modal>
  );
}
