"use client";

import { useState, useTransition } from "react";
import { goalLabel } from "./goal-strip";
import { ErrorNote, field, tap } from "./kit";

type Result = { error: string | null };
type Fn<I> = (input: I) => Promise<Result>;

export type ProgressGoal = {
  id: string;
  kidId: string;
  choreTitle: string;
  choreIcon: string;
  kind: "streak" | "count";
  target: number;
  progress: number;
  reached: boolean;
  achievedOn: string | null;
  rewardGivenAt: string | null;
  reward: string;
  rewardEmoji: string;
  startedOn: string;
  unit: "days" | "weeks" | "times";
};

export type ProgressKid = {
  kidId: string;
  kidName: string;
  color: string;
  emoji: string;
  weeks: { weekStart: string; stars: number }[];
  chores: { id: string; title: string; icon: string; recurrence: "daily" | "weekly" | "once"; grid: ("done" | "missed" | "none")[]; streak: number; best: number; doneCount: number }[];
  goalsDone: ProgressGoal[];
  goals: ProgressGoal[];
  badges: { key: string; emoji: string; label: string }[];
  stars: { saved: number; lifetime: number };
  prizesGiven: { id: string; prizeName: string; emoji: string; stars: number; givenAt: string }[];
};

export type PrizeView = { id: string; name: string; emoji: string; stars: number };

export type ProgressActions = {
  create: Fn<{ kidId: string; choreId: string; kind: "streak" | "count"; target: number; reward: string; rewardEmoji?: string }>;
  rewardGiven: Fn<{ id: string }>;
  repeat: Fn<{ id: string }>;
  archive: Fn<{ id: string }>;
  givePrize: Fn<{ kidId: string; prizeId: string }>;
  undoPrize: Fn<{ id: string }>;
  savePrize: Fn<{ id?: string; name: string; emoji?: string; stars: number }>;
  removePrize: Fn<{ id: string }>;
};

const REWARD_EMOJI = ["🎁", "🎮", "🍦", "🍕", "🎬", "📱", "🧸", "🏆", "💵", "🎨", "⚽", "📚"];

/** Parents' view on the phone: each kid's chores over 12 weeks, goals with rewards, and rewards given. */
export function ProgressView({ kids, days, prizes, actions }: { kids: ProgressKid[]; days: string[]; prizes: PrizeView[]; actions: ProgressActions }) {
  const [kidId, setKidId] = useState(kids[0]?.kidId ?? "");
  const kid = kids.find((k) => k.kidId === kidId);
  if (!kid) return <p className="opacity-70">Add kids and chores on the Family hub first.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {kids.map((k) => (
          <button
            key={k.kidId}
            type="button"
            onClick={() => setKidId(k.kidId)}
            className={`${tap} border-4`}
            style={{ borderColor: k.kidId === kidId ? k.color : "transparent", background: k.kidId === kidId ? `${k.color}22` : undefined }}
          >
            {k.emoji} {k.kidName}
          </button>
        ))}
      </div>

      <StarBankSection kid={kid} prizes={prizes} actions={actions} />

      <section className="space-y-2 rounded-2xl border p-3">
        <h2 className="text-lg font-semibold">🎯 Goals</h2>
        {kid.goals.length === 0 ? <p className="text-sm opacity-70">No goals yet. Streaks work best: “Read 10 days in a row → a prize”.</p> : null}
        <ul className="space-y-2">
          {kid.goals.map((g) => (
            <GoalRow key={g.id} goal={g} color={kid.color} actions={actions} />
          ))}
        </ul>
        <NewGoal kid={kid} create={actions.create} />
      </section>

      {kid.badges.length > 0 ? (
        <section className="rounded-2xl border p-3">
          <h2 className="mb-2 text-lg font-semibold">🏅 Badges</h2>
          <div className="flex flex-wrap gap-2">
            {kid.badges.map((b) => (
              <span key={b.key} className="rounded-full bg-slate-100 px-3 py-1 text-sm dark:bg-slate-800">
                {b.emoji} {b.label}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3 rounded-2xl border p-3">
        <h2 className="text-lg font-semibold">📅 Last 12 weeks</h2>
        <StarsChart weeks={kid.weeks} color={kid.color} />
        {kid.chores.length === 0 ? <p className="text-sm opacity-70">No daily or weekly chores.</p> : null}
        {kid.chores.map((c) => (
          <div key={c.id} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">
                {c.icon} {c.title} {c.recurrence === "weekly" ? <span className="text-xs opacity-60">weekly</span> : null}
              </span>
              <span className="shrink-0 opacity-70">
                🔥 {c.streak} · best {c.best} · {c.doneCount}× in 12 wks
              </span>
            </div>
            <Heatmap grid={c.grid} days={days} color={kid.color} />
          </div>
        ))}
      </section>

      {kid.goalsDone.length > 0 ? (
        <section className="rounded-2xl border p-3">
          <h2 className="mb-2 text-lg font-semibold">🎁 Rewards given</h2>
          <ul className="space-y-1 text-sm">
            {kid.goalsDone.map((g) => (
              <li key={g.id} className="flex justify-between gap-2">
                <span>
                  {g.choreIcon} {goalLabel(g)} → {g.rewardEmoji} {g.reward}
                </span>
                <span className="shrink-0 opacity-60">{g.achievedOn}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="rounded-2xl border p-3 text-sm">
        <summary className="font-semibold">Ideas that keep kids going</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 opacity-80">
          <li>Start short (5 to 7 days) so the first reward comes quickly, then stretch: 10, then 30 days.</li>
          <li>Ladder rewards: a small treat at 10 days and the big unlock (like a game account) at 30.</li>
          <li>Hand rewards over soon after the 🎉 shows on the kitchen screen, then tap “Reward given”.</li>
          <li>Count goals (“read 20 times”) are gentler than streaks for chores that can&apos;t happen every day.</li>
          <li>Celebrate badges out loud: 🔥 a week, 🚀 two weeks, 🏆 30 days.</li>
        </ul>
      </details>
    </div>
  );
}

function GoalRow({ goal: g, color, actions }: { goal: ProgressGoal; color: string; actions: ProgressActions }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      setError(r.error);
    });
  return (
    <li className={`space-y-1 rounded-xl border-2 p-2 ${g.reached ? "border-amber-400 bg-amber-50" : ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          {g.choreIcon} {goalLabel(g)}
        </span>
        <span className="shrink-0 text-sm">
          {g.progress}/{g.target}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full" style={{ width: `${Math.round((g.progress / g.target) * 100)}%`, background: color }} />
      </div>
      <div className="text-sm opacity-80">
        Reward: {g.rewardEmoji} {g.reward} · since {g.startedOn}
        {g.reached ? ` · reached ${g.achievedOn}` : ""}
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        {g.reached ? (
          <button type="button" disabled={pending} className={`${tap} bg-emerald-600 text-sm text-white`} onClick={() => run(() => actions.rewardGiven({ id: g.id }))}>
            ✓ Reward given
          </button>
        ) : null}
        {g.reached ? (
          <button type="button" disabled={pending} className={`${tap} border text-sm`} onClick={() => run(() => actions.repeat({ id: g.id }))}>
            ↻ Same goal again
          </button>
        ) : null}
        <button type="button" disabled={pending} className={`${tap} text-sm opacity-60`} onClick={() => run(() => actions.archive({ id: g.id }))}>
          Remove
        </button>
      </div>
      <ErrorNote error={error} />
    </li>
  );
}

function NewGoal({ kid, create }: { kid: ProgressKid; create: ProgressActions["create"] }) {
  const chores = kid.chores;
  const [open, setOpen] = useState(false);
  const [emoji, setEmoji] = useState(REWARD_EMOJI[0]);
  const [kind, setKind] = useState<"streak" | "count">("streak");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} disabled={chores.length === 0} className={`${tap} w-full border-2 border-dashed`}>
        + New goal for {kid.kidName}
      </button>
    );
  }
  return (
    <form
      className="space-y-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        try {
          const r = await create({
            kidId: kid.kidId,
            choreId: String(f.get("choreId")),
            kind,
            target: Number(f.get("target")),
            reward: String(f.get("reward") ?? ""),
            rewardEmoji: emoji,
          });
          if (r.error) setError(r.error);
          else setOpen(false);
        } catch {
          setError("That didn't save. Try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="grid gap-1 text-sm">
        Chore
        <select name="choreId" className={field} required>
          {chores.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon} {c.title} ({c.recurrence})
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        {(["streak", "count"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={`${tap} flex-1 border-2 text-sm ${kind === k ? "border-sky-600 bg-sky-50" : ""}`}>
            {k === "streak" ? "🔥 In a row" : "➕ Total times"}
          </button>
        ))}
      </div>
      <label className="grid gap-1 text-sm">
        {kind === "streak" ? "How many days (or weeks) in a row" : "How many times"}
        <input name="target" type="number" min={2} max={365} defaultValue={10} required className={field} />
      </label>
      <label className="grid gap-1 text-sm">
        Reward
        <input name="reward" maxLength={80} required placeholder="e.g. Roblox account, pick a prize, ice cream trip" className={field} />
      </label>
      <div className="flex flex-wrap gap-1">
        {REWARD_EMOJI.map((e) => (
          <button key={e} type="button" onClick={() => setEmoji(e)} className={`h-11 w-11 rounded-lg text-2xl ${emoji === e ? "bg-sky-200 ring-2 ring-sky-500" : "bg-white dark:bg-slate-700"}`}>
            {e}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={`${tap} flex-1 bg-sky-600 text-white disabled:opacity-50`}>
          Start goal today
        </button>
        <button type="button" onClick={() => setOpen(false)} className={`${tap} border`}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** 12 weeks as columns, Monday to Sunday as rows. */
function Heatmap({ grid, days, color }: { grid: ("done" | "missed" | "none")[]; days: string[]; color: string }) {
  // Pad the front so the first column starts on a Monday.
  const firstWeekday = (new Date(`${days[0]}T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells: ("done" | "missed" | "none" | "pad")[] = [...Array(firstWeekday).fill("pad"), ...grid];
  const cols = Math.ceil(cells.length / 7);
  return (
    <div className="grid gap-[3px]" style={{ gridTemplateRows: "repeat(7, 0.7rem)", gridAutoFlow: "column", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {cells.map((c, i) => (
        <span
          key={i}
          className={`rounded-[3px] ${c === "missed" ? "bg-slate-200 dark:bg-slate-700" : c === "none" ? "bg-slate-50 dark:bg-slate-800" : ""}`}
          style={c === "done" ? { background: color } : undefined}
          title={c === "pad" ? undefined : `${days[i - firstWeekday]}: ${c}`}
        />
      ))}
    </div>
  );
}

function StarsChart({ weeks, color }: { weeks: { weekStart: string; stars: number }[]; color: string }) {
  const max = Math.max(1, ...weeks.map((w) => w.stars));
  return (
    <div>
      <div className="flex h-20 items-end gap-1">
        {weeks.map((w) => (
          <div key={w.weekStart} className="flex h-full flex-1 flex-col items-center justify-end" title={`Week of ${w.weekStart}: ${w.stars} stars`}>
            <span className="text-[10px] opacity-70">{w.stars || ""}</span>
            <div className="w-full rounded-t" style={{ height: `${(w.stars / max) * 80}%`, minHeight: w.stars ? 2 : 0, background: color }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] opacity-60">
        <span>{weeks[0]?.weekStart.slice(5)}</span>
        <span>⭐ per week</span>
        <span>this week</span>
      </div>
    </div>
  );
}

/**
 * Piggy bank: chores add stars, giving a prize spends them, so a kid can
 * cash in a small prize or keep saving for a big one.
 */
function StarBankSection({ kid, prizes, actions }: { kid: ProgressKid; prizes: PrizeView[]; actions: ProgressActions }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      setError(r.error);
    });
  const saved = kid.stars.saved;
  return (
    <section className="space-y-2 rounded-2xl border-2 border-yellow-300 bg-yellow-50 p-3 text-yellow-950">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">🐷 Star bank</h2>
        <span className="text-sm">{kid.stars.lifetime} ⭐ earned in all</span>
      </div>
      <div className="text-3xl font-bold">{saved} ⭐ saved</div>
      <ul className="space-y-1">
        {prizes.map((p) => {
          const ready = saved >= p.stars;
          return (
            <li key={p.id} className="flex items-center gap-2">
              <span className="text-2xl">{p.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {p.name} · {p.stars} ⭐
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-yellow-200">
                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.round((saved / p.stars) * 100))}%`, background: kid.color }} />
                </div>
              </div>
              <button
                type="button"
                disabled={!ready || pending}
                className={`${tap} shrink-0 text-sm ${ready ? "bg-emerald-600 text-white" : "border opacity-50"}`}
                onClick={() => run(() => actions.givePrize({ kidId: kid.kidId, prizeId: p.id }))}
              >
                {ready ? `Give (−${p.stars})` : `${p.stars - saved} to go`}
              </button>
            </li>
          );
        })}
      </ul>
      <ErrorNote error={error} />
      {kid.prizesGiven.length > 0 ? (
        <details className="text-sm">
          <summary className="font-medium">Prizes given ({kid.prizesGiven.length})</summary>
          <ul className="mt-1 space-y-1">
            {kid.prizesGiven.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-2">
                <span>
                  {g.emoji} {g.prizeName} · −{g.stars} ⭐ · {g.givenAt.slice(0, 10)}
                </span>
                <button type="button" disabled={pending} className="underline opacity-70" onClick={() => run(() => actions.undoPrize({ id: g.id }))}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <button type="button" className="text-sm underline" onClick={() => setEditing((e) => !e)}>
        {editing ? "Done editing prizes" : "Edit prizes (for all kids)"}
      </button>
      {editing ? <PrizeEditor prizes={prizes} actions={actions} /> : null}
    </section>
  );
}

function PrizeEditor({ prizes, actions }: { prizes: PrizeView[]; actions: ProgressActions }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = (form: HTMLFormElement, id?: string) => {
    const f = new FormData(form);
    start(async () => {
      const r = await actions.savePrize({ id, name: String(f.get("name") ?? ""), emoji: String(f.get("emoji") ?? "") || undefined, stars: Number(f.get("stars")) });
      setError(r.error);
      if (!r.error && !id) form.reset();
    });
  };
  const row = "grid grid-cols-[3rem_1fr_5rem_auto] items-center gap-1";
  return (
    <div className="space-y-2 rounded-xl bg-white p-2 text-slate-900">
      {prizes.map((p) => (
        <form
          key={`${p.id}-${p.name}-${p.stars}-${p.emoji}`}
          className={row}
          onSubmit={(e) => {
            e.preventDefault();
            submit(e.currentTarget, p.id);
          }}
        >
          <input name="emoji" defaultValue={p.emoji} maxLength={8} className={`${field} px-1 text-center`} aria-label="Emoji" />
          <input name="name" defaultValue={p.name} maxLength={40} required className={`${field} min-w-0`} aria-label="Prize" />
          <input name="stars" type="number" min={1} max={10000} defaultValue={p.stars} required className={`${field} px-1`} aria-label="Stars" />
          <div className="flex">
            <button type="submit" disabled={pending} className={`${tap} px-2 text-sm`}>
              Save
            </button>
            <button type="button" disabled={pending} className={`${tap} px-2 text-sm opacity-60`} aria-label="Remove prize" onClick={() => start(async () => setError((await actions.removePrize({ id: p.id })).error))}>
              🗑
            </button>
          </div>
        </form>
      ))}
      <form
        className={row}
        onSubmit={(e) => {
          e.preventDefault();
          submit(e.currentTarget);
        }}
      >
        <input name="emoji" placeholder="🎁" maxLength={8} className={`${field} px-1 text-center`} aria-label="Emoji" />
        <input name="name" placeholder="New prize" maxLength={40} required className={`${field} min-w-0`} aria-label="Prize" />
        <input name="stars" type="number" min={1} max={10000} placeholder="⭐" required className={`${field} px-1`} aria-label="Stars" />
        <button type="submit" disabled={pending} className={`${tap} px-2 text-sm`}>
          Add
        </button>
      </form>
      <ErrorNote error={error} />
    </div>
  );
}
