"use client";

import type { ReactNode } from "react";

/** Small shared pieces for the kiosk and phone views. Every tap target is at least 48x48 px. */
export const tap = "min-h-12 min-w-12 rounded-xl px-4 font-medium active:scale-95 transition-transform select-none";
export const field = "min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="max-h-full w-full max-w-lg overflow-auto rounded-2xl bg-white p-5 text-slate-900 shadow-2xl dark:bg-slate-900 dark:text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className={`${tap} text-2xl`}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(value * 100)}%`, background: color }} />
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <p className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p> : null;
}

export function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // Server errors reach the browser as a generic message in production.
  return /card number/i.test(m) ? m : "That didn't save. Try again.";
}
