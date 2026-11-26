"use client";

import { useEffect, useRef, useState, useTransition } from "react";

export type SlideshowView = {
  configured: boolean;
  photos: number;
  pick: null | { pickerUri: string; stage: "picking" | "copying"; copied: number; total: number; mode: "replace" | "add" };
  max: number;
  /** The photos in the slideshow, in order. */
  ids: string[];
};

type Step =
  | { state: "none" }
  | { state: "picking" }
  | { state: "copying"; copied: number; total: number }
  | { state: "done"; photos: number; skipped: number; added?: number; already?: number };

type Actions = {
  choose: (input: { mode: "replace" | "add" }) => Promise<{ url: string | null; error: string | null }>;
  step: (input: Record<string, never>) => Promise<{ result: Step | null; error: string | null }>;
  cancel: (input: Record<string, never>) => Promise<void>;
  clear: (input: Record<string, never>) => Promise<void>;
  photo: (input: { id: string }) => Promise<string | null>;
  upload: (input: { file: File; replaceId?: string }) => Promise<{ id: string | null; error: string | null }>;
  remove: (input: { id: string }) => Promise<void>;
};

/** Shrinks a photo in the browser to screen size (JPEG), so uploads stay small. */
async function toScreenSize(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("That file isn't a photo this browser can open (JPEG, PNG or WebP).");
  const scale = Math.min(1, 1920 / bitmap.width, 1200 / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("Could not read that photo.");
  return new File([blob], "photo.jpg", { type: "image/jpeg" });
}

/** Settings → Kitchen slideshow: photos the kitchen screen shows while it sleeps. */
export function SlideshowSettings({ view, actions }: { view: SlideshowView; actions: Actions }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<Step | null>(view.pick ? (view.pick.stage === "copying" ? { state: "copying", copied: view.pick.copied, total: view.pick.total } : { state: "picking" }) : null);
  const busy = useRef(false);
  const [uploading, setUploading] = useState<string | null>(null);

  const choose = (mode: "replace" | "add") =>
    start(async () => {
      const r = await actions.choose({ mode });
      if (r.url) window.location.href = r.url;
      else setNote(r.error);
    });

  const upload = (files: File[]) =>
    start(async () => {
      setNote(null);
      let added = 0;
      const problems: string[] = [];
      for (const [i, f] of files.entries()) {
        setUploading(`Uploading ${i + 1} of ${files.length}…`);
        try {
          const r = await actions.upload({ file: await toScreenSize(f) });
          if (r.error) problems.push(r.error);
          else added++;
        } catch (err) {
          problems.push(err instanceof Error ? err.message : "Upload failed.");
        }
      }
      setUploading(null);
      setNote(`${added ? `Added ${added} photo${added === 1 ? "" : "s"}.` : ""}${problems.length ? ` ${[...new Set(problems)].join(" ")}` : ""}`.trim());
    });

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
            const d = r.result;
            const head = d.added !== undefined ? `Added ${d.added} photos (${d.photos} in the slideshow now).` : `${d.photos} photos are in the slideshow.`;
            setNote(
              `${head}${d.already ? ` ${d.already} were already in it.` : ""}${d.skipped ? ` ${d.skipped} videos or unreadable items were left out.` : ""}`,
            );
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
        keeps them encrypted, and can&apos;t see the rest of your library. You can add more from Google Photos or from this
        device, remove or replace single photos below, or replace the whole set with a new pick. Photos added to the album
        later appear only after you add them here. At night (9 PM–6:30 AM) the sleeping screen stays dark.
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending || !view.configured}
            className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50"
            onClick={() => choose(view.photos ? "add" : "replace")}
          >
            {view.photos ? "Add from Google Photos" : "Choose photos from Google Photos"}
          </button>
          <label className={`cursor-pointer rounded-lg border px-4 py-2 ${pending || !view.configured ? "pointer-events-none opacity-50" : ""}`}>
            Upload from this device
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/*"
              multiple
              className="sr-only"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length) upload(files);
              }}
            />
          </label>
          {view.photos ? (
            <>
              <button type="button" disabled={pending} className="underline disabled:opacity-50" onClick={() => choose("replace")}>
                Replace all from Google Photos
              </button>
              <button
                type="button"
                disabled={pending}
                className="underline disabled:opacity-50"
                onClick={() => {
                  if (window.confirm("Remove all photos from the slideshow?")) start(async () => (await actions.clear({}), setNote("Slideshow emptied.")));
                }}
              >
                Remove all photos
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {uploading ? <p role="status">{uploading}</p> : null}
      {view.ids.length ? <PhotoGrid ids={view.ids} actions={actions} disabled={active || pending} onNote={setNote} /> : null}
    </div>
  );
}

/** The slideshow's photos as small tiles, each with Replace and Remove. Tiles load as they scroll into view. */
function PhotoGrid({ ids, actions, disabled, onNote }: { ids: string[]; actions: Actions; disabled: boolean; onNote: (n: string | null) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="space-y-2">
      <button type="button" className="text-sm underline" onClick={() => setOpen(!open)}>
        {open ? "Hide photos" : `Show the ${ids.length} photos (to remove or replace one)`}
      </button>
      {open ? (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {ids.map((id) => (
            <PhotoTile key={id} id={id} actions={actions} disabled={disabled} onNote={onNote} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PhotoTile({ id, actions, disabled, onNote }: { id: string; actions: Actions; disabled: boolean; onNote: (n: string | null) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void actions.photo({ id }).then((url) => {
        if (!cancelled) setSrc(url);
      });
    });
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [id, actions]);
  if (gone) return null;
  return (
    <li ref={ref} className="overflow-hidden rounded-lg border">
      <div className="aspect-[4/3] bg-black/5">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the app's own encrypted store
          <img src={src} alt="Slideshow photo" className="h-full w-full object-cover" />
        ) : null}
      </div>
      <div className="flex text-xs">
        <label className={`flex-1 cursor-pointer py-1.5 text-center hover:bg-black/5 ${disabled || working ? "pointer-events-none opacity-50" : ""}`}>
          Replace
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/*"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setWorking(true);
              onNote(null);
              try {
                const r = await actions.upload({ file: await toScreenSize(f), replaceId: id });
                if (r.error) onNote(r.error);
                else onNote("Photo replaced.");
              } catch (err) {
                onNote(err instanceof Error ? err.message : "Upload failed.");
              } finally {
                setWorking(false);
              }
            }}
          />
        </label>
        <button
          type="button"
          disabled={disabled || working}
          className="flex-1 border-l py-1.5 text-red-700 hover:bg-black/5 disabled:opacity-50 dark:text-red-300"
          onClick={async () => {
            setWorking(true);
            await actions.remove({ id });
            setGone(true);
            onNote("Photo removed.");
          }}
        >
          Remove
        </button>
      </div>
    </li>
  );
}
