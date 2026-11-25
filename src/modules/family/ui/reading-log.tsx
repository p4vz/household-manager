"use client";

import { useRef, useState, useTransition } from "react";
import { ErrorNote, Modal, field, tap } from "./kit";

export type ReadingLanguageView = "en" | "ru";
export type ShelfBookView = { id: string; title: string; author: string | null; language: ReadingLanguageView; finished: boolean };
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
  /** The kid's book shelf: being read (last read first), then finished. */
  books: ShelfBookView[];
};
type Result = { error: string | null };
export type ReadingActions = {
  log: (input: { kidId: string; day?: string; book: string; language: ReadingLanguageView; minutes: number; pages?: number | null }) => Promise<Result>;
  remove: (input: { id: string }) => Promise<Result>;
  addBook: (input: { kidId: string; title: string; author?: string | null; language: ReadingLanguageView }) => Promise<Result>;
  setFinished: (input: { id: string; finished: boolean }) => Promise<Result>;
  /** Parents only (phone, or adult mode on the kitchen screen). */
  removeBook?: (input: { id: string }) => Promise<Result>;
  /** Parents only: Claude reads title and author off a cover photo. */
  readCover?: (input: { image: string }) => Promise<Result & { book?: { title: string; author: string | null; language: ReadingLanguageView } }>;
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
  const reading_ = reading.books.filter((b) => !b.finished);
  const [day, setDay] = useState(today);
  // Picked by title (unique on a kid's shelf), so a book just added is picked once the screen refreshes.
  const [picked, setPicked] = useState<string | null>(reading_[0]?.title.toLowerCase() ?? null);
  const book = reading.books.find((b) => b.title.toLowerCase() === picked) ?? null;
  const [minutes, setMinutes] = useState<number | "">(NEED[reading_[0]?.language ?? "en"]);
  const [pages, setPages] = useState<number | "">("");
  const [adding, setAdding] = useState(reading_.length === 0);
  const [showFinished, setShowFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const pick = (b: ShelfBookView) => {
    setPicked(b.title.toLowerCase());
    if (minutes === NEED.en || minutes === NEED.ru || minutes === "") setMinutes(NEED[b.language]);
  };

  const save = () =>
    start(async () => {
      if (!book || !minutes) {
        setError(!book ? "Pick a book on the left." : "How many minutes?");
        return;
      }
      const r = await actions.log({ kidId, day, book: book.title, language: book.language, minutes: Number(minutes), pages: pages === "" ? null : Number(pages) });
      setError(r.error);
      if (!r.error) onClose();
    });

  const shown = showFinished ? reading.books : reading_;
  const finishedCount = reading.books.length - reading_.length;

  return (
    <Modal title={`📖 ${kidName}'s reading`} onClose={onClose} wide>
      <div className="grid gap-4 md:grid-cols-[15rem_1fr]">
        <section aria-label="Books" className="space-y-2 md:border-r md:pr-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">📚 Books</div>
            <button type="button" onClick={() => setAdding((a) => !a)} className="min-h-9 rounded-lg border border-sky-300 px-2 text-sm font-medium text-sky-800">
              {adding ? "Close" : "＋ New book"}
            </button>
          </div>
          {adding ? (
            <NewBook
              kidId={kidId}
              actions={actions}
              onAdded={(title, language) => {
                setAdding(false);
                setPicked(title.toLowerCase());
                setMinutes(NEED[language]);
              }}
            />
          ) : null}
          <ul className="max-h-[50vh] space-y-1 overflow-auto">
            {shown.map((b) => (
              <li key={b.id} className="flex items-stretch gap-1">
                <button
                  type="button"
                  onClick={() => pick(b)}
                  className={`min-h-11 flex-1 rounded-lg border px-2 py-1 text-left text-sm ${book?.id === b.id ? "border-sky-500 bg-sky-100 font-semibold" : "border-slate-200"} ${b.finished ? "opacity-60" : ""}`}
                >
                  <span className="block leading-tight">
                    {FLAG[b.language]} {b.title}
                  </span>
                  {b.author ? <span className="block text-xs font-normal opacity-70">{b.author}</span> : null}
                </button>
                <button
                  type="button"
                  title={b.finished ? "Reading it again" : "Finished this book"}
                  aria-label={b.finished ? `Reading ${b.title} again` : `Finished ${b.title}`}
                  onClick={() => start(async () => setError((await actions.setFinished({ id: b.id, finished: !b.finished })).error))}
                  className="min-h-11 w-10 rounded-lg border border-slate-200 text-sm"
                >
                  {b.finished ? "↩" : "✓"}
                </button>
                {actions.removeBook && b.finished ? (
                  <button
                    type="button"
                    aria-label={`Remove ${b.title}`}
                    onClick={() => start(async () => setError((await actions.removeBook!({ id: b.id })).error))}
                    className="min-h-11 w-9 rounded-lg text-sm opacity-70"
                  >
                    🗑
                  </button>
                ) : null}
              </li>
            ))}
            {shown.length === 0 && !adding ? <li className="text-sm opacity-60">No books yet. Add one.</li> : null}
          </ul>
          {finishedCount > 0 ? (
            <button type="button" onClick={() => setShowFinished((v) => !v)} className="text-xs font-medium text-sky-800 underline">
              {showFinished ? "Hide finished books" : `Show finished books (${finishedCount})`}
            </button>
          ) : null}
        </section>

        <section className="space-y-3">
          <p className="text-sm opacity-70">A day counts with 20 minutes in English or 15 in Russian.</p>
          <div className="rounded-xl bg-sky-50 px-3 py-2 text-sky-950">
            {book ? (
              <>
                <span className="font-semibold">
                  {FLAG[book.language]} {book.title}
                </span>
                {book.author ? <span className="text-sm opacity-70"> · {book.author}</span> : null}
              </>
            ) : (
              <span className="text-sm">Pick a book from the list.</span>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">
            Date
            <input type="date" className={`${field} flex-1`} value={day} max={today} onChange={(e) => setDay(e.target.value || today)} />
          </label>
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
        </section>
      </div>
    </Modal>
  );
}

/** Shrinks a photo in the browser (also drops its metadata) and returns base64 JPEG. */
async function coverToBase64(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "";
}

/** Add a book by typing, or (parents) from a photo of the cover. */
function NewBook({ kidId, actions, onAdded }: { kidId: string; actions: ReadingActions; onAdded: (title: string, language: ReadingLanguageView) => void }) {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [language, setLanguage] = useState<ReadingLanguageView>("en");
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const fromCover = async (file: File | undefined) => {
    if (!file || !actions.readCover) return;
    setError(null);
    setReading(true);
    try {
      const r = await actions.readCover({ image: await coverToBase64(file) });
      if (r.error || !r.book) setError(r.error ?? "Couldn't read the cover.");
      else {
        setTitle(r.book.title);
        setAuthor(r.book.author ?? "");
        setLanguage(r.book.language);
      }
    } catch {
      setError("Couldn't read that picture. Try another one.");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const add = () =>
    start(async () => {
      if (!title.trim()) return setError("Which book?");
      const r = await actions.addBook({ kidId, title: title.trim(), author: author.trim() || null, language });
      setError(r.error);
      if (!r.error) onAdded(title.trim().replace(/\s+/g, " "), language);
    });

  return (
    <div className="space-y-2 rounded-xl border border-sky-200 p-2">
      {actions.readCover ? (
        <>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => fromCover(e.target.files?.[0])} aria-label="Cover photo" />
          <button type="button" disabled={reading} onClick={() => fileRef.current?.click()} className="min-h-10 w-full rounded-lg bg-sky-100 px-2 text-sm font-medium text-sky-900">
            {reading ? "Reading the cover…" : "📷 Photo of the cover"}
          </button>
        </>
      ) : null}
      <input className={`${field} min-h-10 w-full`} placeholder="Title" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      <input className={`${field} min-h-10 w-full`} placeholder="Author (optional)" maxLength={80} value={author} onChange={(e) => setAuthor(e.target.value)} aria-label="Author" />
      <div className="grid grid-cols-2 gap-1">
        {(["en", "ru"] as const).map((l) => (
          <button key={l} type="button" onClick={() => setLanguage(l)} className={`min-h-10 rounded-lg border-2 text-sm ${language === l ? "border-sky-500 bg-sky-100" : "border-slate-200"}`}>
            {FLAG[l]} {l === "en" ? "English" : "Russian"}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      <button type="button" disabled={pending || reading} onClick={add} className="min-h-10 w-full rounded-lg bg-sky-600 px-2 text-sm font-semibold text-white">
        Add to shelf
      </button>
    </div>
  );
}
