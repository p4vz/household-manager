"use client";

import { useEffect, useRef, useState, useTransition } from "react";

export type SlideshowView = {
  configured: boolean;
  photos: number;
  pick: null | { pickerUri: string; stage: "picking" | "copying"; copied: number; total: number };
  max: number;
};

type Step =
  | { state: "none" }
  | { state: "picking" }
  | { state: "copying"; copied: number; total: number }
  | { state: "done"; photos: number; skipped: number };

type Actions = {
  choose: (input: Record<string, never>) => Promise<{ url: string | null; error: string | null }>;
  step: (input: Record<string, never>) => Promise<{ result: Step | null; error: string | null }>;
  cancel: (input: Record<string, never>) => Promise<void>;
  clear: (input: Record<string, never>) => Promise<void>;
};

/** Settings → Kitchen slideshow: photos the kitchen screen shows while it sleeps. */
export function SlideshowSettings({ view, actions }: { view: SlideshowView; actions: Actions }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<Step | null>(view.pick ? (view.pick.stage === "copying" ? { state: "copying", copied: view.pick.copied, total: view.pick.total } : { state: "picking" }) : null);
  const busy = useRef(false);

  // While a pick is open, ask the server every few seconds whether the photos are chosen, then copy them in steps.
  const active = progress?.state === "picking" || progress?.state === "copying";
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      if (busy.current || stop) return;
      busy.current = true;
      try {
        const r = await actions.step({});
        if (stop) return;
        if (r.error) {
          setNote(r.error);
          setProgress(null);
        } else if (r.result) {
          setProgress(r.result.state === "none" ? null : r.result);
          if (r.result.state === "done") {
            setNote(`${r.result.photos} photos are in the slideshow.${r.result.skipped ? ` ${r.result.skipped} videos or unreadable items were left out.` : ""}`);
          }
        }
      } finally {
        busy.current = false;
      }
    };
    const timer = setInterval(tick, progress?.state === "copying" ? 1000 : 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [active, progress?.state, actions]);

  return (
    <div className="space-y-3 text-sm">
      <p className="opacity-80">
        When the kitchen screen is in Timeout mode and goes to sleep, it shows these photos one after another instead of a dark
        screen. You pick them in Google Photos, for example every photo in one album. The app copies them once at screen size,
        keeps them encrypted, and can&apos;t see the rest of your library. To change the set, choose photos again: the new pick
        replaces the old one. Photos added to the album later appear only after you pick again. At night (9 PM–6:30 AM) the sleeping screen stays dark.
      </p>
      {!view.configured ? (
        <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">DOC_VAULT_KEY is not set on the server, so photos can&apos;t be stored.</p>
      ) : null}
      <div className="opacity-80">{view.photos ? `${view.photos} photos in the slideshow.` : "No photos yet. The sleeping screen stays dark."}</div>
      {progress?.state === "picking" && view.pick ? (
        <div className="space-y-2 rounded-lg border border-sky-500/50 bg-sky-500/10 p-3">
          <div className="font-medium">Pick the photos in Google Photos</div>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Tap Open Google Photos.</li>
            <li>Open Albums, open the album, and select its photos (on a computer, click the first photo, then Shift-click the last one). Up to {view.max}.</li>
            <li>Tap Done. This page copies them by itself.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <a href={`${view.pick.pickerUri}/autoclose`} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-foreground px-4 py-2 text-background">
              Open Google Photos
            </a>
            <button type="button" disabled={pending} className="underline disabled:opacity-50" onClick={() => start(async () => (await actions.cancel({}), setProgress(null)))}>
              Cancel
            </button>
          </div>
          <div className="opacity-60">Waiting for your pick…</div>
        </div>
      ) : null}
      {progress?.state === "copying" ? (
        <div className="rounded-lg border p-3">
          Copying photos: {progress.copied} of {progress.total}…
        </div>
      ) : null}
      {note ? <p role="status">{note}</p> : null}
      {!active ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending || !view.configured}
            className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50"
            onClick={() =>
              start(async () => {
                const r = await actions.choose({});
                if (r.url) window.location.href = r.url;
                else setNote(r.error);
              })
            }
          >
            {view.photos ? "Choose photos again" : "Choose photos from Google Photos"}
          </button>
          {view.photos ? (
            <button type="button" disabled={pending} className="underline disabled:opacity-50" onClick={() => start(async () => (await actions.clear({}), setNote("Slideshow emptied.")))}>
              Remove all photos
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
