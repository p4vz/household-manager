"use client";

import { startTransition, useOptimistic, useState } from "react";
import { GoalStrip, type KidProgressView } from "./goal-strip";
import { ReadingRow, type ReadingActions } from "./reading-log";
import { Modal, field, tap } from "./kit";

export type BoardChoreView = { id: string; title: string; icon: string; recurrence: "daily" | "weekly" | "once"; stars: number; done: boolean };
export type BoardKidView = {
  id: string;
  name: string;
  color: string;
  emoji: string;
  chores: BoardChoreView[];
  stats: { todayDone: number; todayTotal: number; weekPercent: number; weekDone: number; weekTotal: number; streak: number; starsWeek: number; starsTotal: number };
};

type Actions = {
  setDone: (input: { choreId: string; done: boolean }) => Promise<void>;
  addOneTime: (input: { kidId: string; title: string; icon?: string }) => Promise<void>;
  /** Reading log (📖 Log under the prize bar). */
  reading?: ReadingActions;
};

/**
 * Per-kid columns of big, icon-first chore cards. One tap ticks a chore
 * (checkmark, stars, progress bar move at once); tapping a done chore asks
 * before un-ticking, so a stray tap from a sibling cannot undo it.
 */
export function ChoreBoard({
  kids,
  actions,
  icons,
  layout = "kiosk",
  progress,
}: {
  kids: BoardKidView[];
  actions: Actions;
  icons: readonly string[];
  layout?: "kiosk" | "phone";
  /** Goals and badges per kid id (goal-strip.tsx). */
  progress?: Record<string, KidProgressView>;
}) {
  const [board, setOptimistic] = useOptimistic(kids, (state, change: { choreId: string; done: boolean }) =>
    state.map((k) => {
      const chores = k.chores.map((c) => (c.id === change.choreId ? { ...c, done: change.done } : c));
      const delta = chores.filter((c) => c.done).length - k.stats.todayDone;
      const starDelta = chores.reduce((s, c) => s + (c.done ? c.stars : 0), 0) - k.chores.reduce((s, c) => s + (c.done ? c.stars : 0), 0);
      return {
        ...k,
        chores,
        stats: {
          ...k.stats,
          todayDone: k.stats.todayDone + delta,
          weekDone: k.stats.weekDone + delta,
          starsWeek: k.stats.starsWeek + starDelta,
          starsTotal: k.stats.starsTotal + starDelta,
        },
      };
    }),
  );
  // Ticks move the kid's points at once too (the star bank comes from the server).
  const starDeltas = new Map(board.map((k) => [k.id, k.stats.starsTotal - (kids.find((x) => x.id === k.id)?.stats.starsTotal ?? k.stats.starsTotal)]));
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
      <div className={`grid min-h-0 flex-1 gap-2 ${layout === "phone" ? "grid-cols-1" : ""}`} style={layout === "kiosk" ? { gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 13rem), 1fr))`, overflowY: "auto" } : undefined}>
        {board.map((kid) => (
          <section key={kid.id} className="flex min-h-0 flex-col rounded-2xl border-[3px] bg-white p-2 dark:bg-slate-900" style={{ borderColor: kid.color }}>
            <header className="mb-1.5 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="truncate text-xl font-bold leading-tight" style={{ color: kid.color }}>
                  {kid.emoji} {kid.name}
                </h3>
                {kid.stats.streak > 0 ? (
                  <span className="shrink-0 text-sm font-semibold" aria-label={`${kid.stats.streak} day streak`}>
                    🔥 {kid.stats.streak}
                  </span>
                ) : null}
              </div>
              <div className="text-sm font-medium opacity-80">
                ⭐ {pointsOf(kid, progress, starDeltas)} points, {kid.stats.weekDone}/{kid.stats.weekTotal} this week
              </div>
              {progress?.[kid.id] ? (
                <GoalStrip
                  progress={progress[kid.id]}
                  color={kid.color}
                  belowStars={
                    progress[kid.id].reading && actions.reading ? (
                      <ReadingRow kidId={kid.id} kidName={kid.name} reading={progress[kid.id].reading!} actions={actions.reading} color={kid.color} />
                    ) : null
                  }
                />
              ) : null}
            </header>
            <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain">
              {kid.chores.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => (c.done ? setConfirmUndo(c) : set(c.id, true))}
                    className={`flex min-h-12 w-full items-center gap-2 rounded-lg border-2 px-2 py-1 text-left transition-colors active:scale-[0.98] ${
                      c.done
                        ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950"
                        : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800"
                    }`}
                  >
                    <span className="text-2xl leading-none" aria-hidden>
                      {c.icon}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className={`break-words text-base font-semibold leading-tight ${c.done ? "line-through opacity-60" : ""}`}>{c.title}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`whitespace-nowrap rounded-full px-1.5 text-xs font-bold leading-5 ${c.done ? "bg-emerald-100 text-emerald-800" : "bg-yellow-100 text-yellow-900"}`}
                          aria-label={`${c.stars} ${c.stars === 1 ? "point" : "points"}`}
                        >
                          +{c.stars} ⭐
                        </span>
                        {c.recurrence !== "daily" ? (
                          <span className="text-[10px] font-medium uppercase opacity-60">{c.recurrence === "weekly" ? "this week" : "today"}</span>
                        ) : null}
                      </span>
                    </span>
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-[3px] text-xl font-black ${
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

/** Points = stars saved in the star bank (spent on prizes), else stars earned in all. */
function pointsOf(kid: BoardKidView, progress: Record<string, KidProgressView> | undefined, deltas: Map<string, number>): number {
  const bank = progress?.[kid.id]?.stars;
  return bank ? Math.max(0, bank.saved + (deltas.get(kid.id) ?? 0)) : kid.stats.starsTotal;
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
