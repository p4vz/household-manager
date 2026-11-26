"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export type SlideshowSource = {
  ids: (input: Record<string, never>) => Promise<string[]>;
  photo: (input: { id: string }) => Promise<string | null>;
};

/** How long each photo stays up. */
const SLIDE_MS = 12_000;

function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The kitchen screen asleep in Timeout mode: the chosen photos one after
 * another, in a shuffled order, cross-fading, with a small clock. Covers the
 * whole screen so the waking tap presses nothing underneath. Shows
 * `fallback` (the dark cover) until the first photo arrives, or when there
 * are none.
 */
export function SleepSlideshow({ source, clock, fallback }: { source: SlideshowSource; clock: string; fallback: ReactNode }) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState<{ a: string | null; b: string | null; front: "a" | "b" }>({ a: null, b: null, front: "a" });
  // The page re-renders every 30 s with fresh action references; keep the show running across that.
  const src = useRef(source);
  useEffect(() => {
    src.current = source;
  }, [source]);

  useEffect(() => {
    let stop = false;
    src.current
      .ids({})
      .then((ids) => !stop && setOrder(shuffled(ids)))
      .catch(() => !stop && setOrder([]));
    return () => {
      stop = true;
    };
  }, []);

  // Load the photo for this step, then fade it in over the previous one.
  useEffect(() => {
    if (!order || order.length === 0) return;
    let stop = false;
    const id = order[index % order.length];
    src.current
      .photo({ id })
      .then((url) => {
        if (stop || !url) return;
        const img = new Image();
        img.onload = () => !stop && setShown((s) => (s.front === "a" ? { ...s, b: url, front: "b" } : { ...s, a: url, front: "a" }));
        img.src = url;
      })
      .catch(() => undefined);
    const next = setTimeout(() => !stop && setIndex((i) => i + 1), SLIDE_MS);
    return () => {
      stop = true;
      clearTimeout(next);
    };
  }, [order, index]);

  if (!order || order.length === 0 || (!shown.a && !shown.b)) return <>{fallback}</>;
  return (
    <div className="fixed inset-0 z-50 bg-black" aria-label="Tap to wake">
      {(["a", "b"] as const).map((k) =>
        shown[k] ? (
          // eslint-disable-next-line @next/next/no-img-element -- a decrypted data: URL, not a static asset
          <img
            key={k}
            src={shown[k]!}
            alt=""
            className="absolute inset-0 h-full w-full object-contain transition-opacity duration-[1500ms]"
            style={{ opacity: shown.front === k ? 1 : 0 }}
          />
        ) : null,
      )}
      <div className="absolute bottom-4 right-6 rounded-xl bg-black/40 px-3 py-1 text-4xl font-light tabular-nums text-white/90">{clock}</div>
    </div>
  );
}
