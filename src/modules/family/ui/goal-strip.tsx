"use client";

import { useState } from "react";
import { Modal } from "./kit";

export type GoalStripGoal = {
  id: string;
  choreTitle: string;
  choreIcon: string;
  kind: "streak" | "count";
  target: number;
  progress: number;
  reached: boolean;
  reward: string;
  rewardEmoji: string;
  unit: "days" | "weeks" | "times";
};
export type StarBankView = {
  saved: number;
  lifetime: number;
  best: { name: string; emoji: string; stars: number } | null;
  next: { name: string; emoji: string; stars: number; missing: number } | null;
};
export type KidProgressView = {
  stars?: StarBankView;
  goals: GoalStripGoal[];
  badges: { key: string; emoji: string; label: string }[];
  bestStreak: number;
  nextBadge: { emoji: string; label: string; days: number } | null;
};

export function goalLabel(g: Pick<GoalStripGoal, "choreTitle" | "kind" | "target" | "unit">): string {
  return g.kind === "streak" ? `${g.choreTitle}: ${g.target} ${g.unit} in a row` : `${g.choreTitle}: ${g.target} times`;
}

/**
 * Kid-facing: what each goal is worth and how close it is, as a trail of
 * steps to the reward, plus badges earned. Shown on the kitchen screen and
 * the phone chore board. Read-only: parents manage goals on the phone.
 */
export function GoalStrip({ progress, color }: { progress: KidProgressView; color: string }) {
  const [showBadges, setShowBadges] = useState(false);
  if (progress.goals.length === 0 && progress.badges.length === 0 && !progress.stars) return null;
  return (
    <div className="space-y-1">
      {progress.stars ? <StarBankRow bank={progress.stars} color={color} /> : null}
      {progress.goals.map((g) => (
        <div
          key={g.id}
          className={`rounded-lg border px-2 py-1 ${g.reached ? "animate-pulse border-amber-400 bg-amber-50" : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800"}`}
        >
          {g.reached ? (
            <div className="text-xs font-bold leading-tight text-amber-900">
              🎉 Goal reached! {g.choreIcon} {g.target} {g.unit} · Ask a parent for {g.rewardEmoji} {g.reward}
            </div>
          ) : (
            <>
              <div className="text-xs font-semibold leading-tight" title={goalLabel(g)}>
                {g.choreIcon} {g.progress}/{g.target} {g.kind === "streak" ? `${g.unit} in a row` : "times"} → {g.rewardEmoji} {g.reward}
              </div>
              <Trail value={g.progress} target={g.target} color={color} />
            </>
          )}
        </div>
      ))}
      {progress.badges.length > 0 ? (
        <button type="button" onClick={() => setShowBadges(true)} className="flex w-full items-center gap-0.5 text-base leading-none" aria-label="Badges">
          {progress.badges.slice(-6).map((b) => (
            <span key={b.key} title={b.label}>
              {b.emoji}
            </span>
          ))}
          {progress.nextBadge ? (
            <span className="ml-auto text-xs font-medium opacity-60">
              {progress.nextBadge.emoji} at {progress.nextBadge.days} days
            </span>
          ) : null}
        </button>
      ) : null}
      {showBadges ? (
        <Modal title="Badges" onClose={() => setShowBadges(false)}>
          <ul className="grid grid-cols-2 gap-2">
            {progress.badges.map((b) => (
              <li key={b.key} className="flex items-center gap-2 rounded-xl bg-slate-100 p-2 dark:bg-slate-800">
                <span className="text-3xl">{b.emoji}</span>
                <span className="font-medium">{b.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm opacity-70">
            Best streak: {progress.bestStreak} day{progress.bestStreak === 1 ? "" : "s"}.
            {progress.nextBadge ? ` Next: ${progress.nextBadge.emoji} ${progress.nextBadge.label} at ${progress.nextBadge.days} days.` : ""}
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/** Steps to the reward: one dot per day up to 14, a bar beyond that. */
function Trail({ value, target, color }: { value: number; target: number; color: string }) {
  if (target > 14) {
    return (
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.round((value / target) * 100)}%`, background: color }} />
      </div>
    );
  }
  return (
    <div className="mt-1 flex gap-0.5" aria-label={`${value} of ${target}`}>
      {Array.from({ length: target }, (_, i) => (
        <span key={i} className="h-1.5 flex-1 rounded-full" style={{ background: i < value ? color : undefined }} data-on={i < value}>
          {i < value ? null : <span className="block h-full rounded-full bg-slate-200 dark:bg-slate-700" />}
        </span>
      ))}
    </div>
  );
}

/** One slim line: the next prize and how far, or "🍭 ready! Ask a parent". Points are on the card's second line. */
function StarBankRow({ bank, color }: { bank: StarBankView; color: string }) {
  const next = bank.next;
  const share = next ? Math.min(1, bank.saved / next.stars) : 1;
  return (
    <div className="rounded-lg border border-yellow-300 bg-yellow-50 px-2 py-1 text-yellow-950">
      <div className="text-xs font-semibold leading-tight">
        {bank.best ? `🎉 ${bank.best.emoji} ${bank.best.name} ready! Ask a parent. ` : "🐷 "}
        {next ? `${next.missing} more → ${next.emoji} ${next.name}` : "Every prize unlocked!"}
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-yellow-200">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(share * 100)}%`, background: color }} />
      </div>
    </div>
  );
}
