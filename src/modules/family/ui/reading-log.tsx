"use client";

import { useState, useTransition } from "react";
import { ErrorNote, Modal, field, tap } from "./kit";

export type ReadingLanguageView = "en" | "ru";
export type ReadingView = {
  /** Household chore day, YYYY-MM-DD (the date field starts here). */
  day: string;
  streak: number;
  totalDays: number;
  /** Today's progress toward counting, 0..1. */
  todayShare: number;
  nextStreakAt: number;
  nextTotalAt: number;
  today: { id: string; book: string; language: ReadingLanguageView; minutes: number; pages: number | null }[];
  books: { book: string; language: ReadingLanguageView }[];
};
export type ReadingActions = {
  log: (input: { kidId: string; day?: string; book: string; language: ReadingLanguageView; minutes: number; pages?: number | null }) => Promise<{ error: string | null }>;
  remove: (input: { id: string }) => Promise<{ error: string | null }>;
};

const FLAG: Record<ReadingLanguageView, string> = { en: "🇺🇸", ru: "🇷🇺" };
const NEED: Record<ReadingLanguageView, number> = { en: 20, ru: 15 };

/**
 * One slim line under the prize bar: today's reading toward the day's goal
 * (20 min English or 15 min Russian), the streak, and a Log button.
 */
export function ReadingRow({ kidId, kidName, reading, actions, color }: { kidId: string; kidName: string; reading: ReadingView; actions: ReadingActions; color: string }) {
  const [open, setOpen] = useState(false);
  const counted = reading.todayShare >= 1;
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50 px-2 py-1 text-sky-950">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 text-xs font-semibold leading-tight">
          📖 {counted ? "Read today ✓" : reading.today.length ? `${Math.round(reading.todayShare * 100)}% of today's reading` : "No reading yet today"}
          <span className="font-normal opacity-80">
            {" "}
            · 🔥 {reading.streak}/{reading.nextStreakAt} in a row · {reading.totalDays}/{reading.nextTotalAt} days
          </span>
        </div>
        <button type="button" onClick={() => setOpen(true)} className="min-h-8 shrink-0 rounded-md bg-sky-600 px-2 text-xs font-semibold text-white active:scale-95">
          ＋ Log
        </button>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-sky-200">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(Math.min(1, reading.todayShare) * 100)}%`, background: color }} />
      </div>
      {open ? <LogModal kidId={kidId} kidName={kidName} reading={reading} actions={actions} today={reading.day} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function LogModal({ kidId, kidName, reading, actions, today, onClose }: { kidId: string; kidName: string; reading: ReadingView; actions: ReadingActions; today: string; onClose: () => void }) {
  const [day, setDay] = useState(today);
  const [book, setBook] = useState(reading.books[0]?.book ?? "");
  const [language, setLanguage] = useState<ReadingLanguageView>(reading.books[0]?.language ?? "en");
  const [minutes, setMinutes] = useState<number | "">(NEED[reading.books[0]?.language ?? "en"]);
  const [pages, setPages] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      if (!book.trim() || !minutes) {
        setError(!book.trim() ? "Which book?" : "How many minutes?");
        return;
      }
      const r = await actions.log({ kidId, day, book: book.trim(), language, minutes: Number(minutes), pages: pages === "" ? null : Number(pages) });
      setError(r.error);
      if (!r.error) onClose();
    });

  return (
    <Modal title={`📖 ${kidName}'s reading`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm opacity-70">A day counts with 20 minutes in English or 15 in Russian.</p>
        <label className="flex items-center gap-2 text-sm font-medium">
          Date
          <input type="date" className={`${field} flex-1`} value={day} max={today} onChange={(e) => setDay(e.target.value || today)} />
        </label>
        {reading.books.length ? (
          <div className="flex flex-wrap gap-1">
            {reading.books.map((b) => (
              <button
                key={b.book}
                type="button"
                onClick={() => {
                  setBook(b.book);
                  setLanguage(b.language);
                }}
                className={`min-h-10 rounded-lg border px-2 text-sm ${book === b.book ? "border-sky-500 bg-sky-100" : "border-slate-300"}`}
              >
                {FLAG[b.language]} {b.book}
              </button>
            ))}
          </div>
        ) : null}
        <input className={`${field} w-full`} placeholder="Book" maxLength={80} value={book} onChange={(e) => setBook(e.target.value)} aria-label="Book" />
        <div className="grid grid-cols-2 gap-2">
          {(["en", "ru"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLanguage(l)}
              className={`${tap} border-2 ${language === l ? "border-sky-500 bg-sky-100" : "border-slate-200"}`}
            >
              {FLAG[l]} {l === "en" ? "English" : "Russian"}
            </button>
          ))}
        </div>
        <div className="space-y-1">
          <div className="text-sm font-medium">Minutes</div>
          <div className="flex flex-wrap gap-1">
            {[10, 15, 20, 30, 45, 60].map((m) => (
              <button key={m} type="button" onClick={() => setMinutes(m)} className={`min-h-10 min-w-12 rounded-lg border px-2 text-sm ${minutes === m ? "border-sky-500 bg-sky-100 font-semibold" : "border-slate-300"}`}>
                {m}
              </button>
            ))}
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={600}
              className={`${field} min-h-10 w-20`}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value === "" ? "" : Number(e.target.value))}
              aria-label="Minutes"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          Pages (optional)
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={2000}
            className={`${field} w-24`}
            value={pages}
            onChange={(e) => setPages(e.target.value === "" ? "" : Number(e.target.value))}
            aria-label="Pages"
          />
        </label>
        <ErrorNote error={error} />
        <button type="button" disabled={pending} onClick={save} className={`${tap} w-full bg-sky-600 text-white`}>
          Save reading
        </button>
        {reading.today.length ? (
          <div className="space-y-1 border-t pt-2">
            <div className="text-sm font-medium">Today</div>
            {reading.today.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  {FLAG[e.language]} {e.book} · {e.minutes} min{e.pages ? ` · ${e.pages} pages` : ""}
                </span>
                <button
                  type="button"
                  className="min-h-10 rounded-lg px-2 opacity-70"
                  aria-label={`Remove ${e.book}`}
                  onClick={() => start(async () => setError((await actions.remove({ id: e.id })).error))}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
