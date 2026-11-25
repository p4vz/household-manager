"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const KEY = "hm-kiosk-split";
const DEFAULT = 0.55;
const MIN = 0.3;
const MAX = 0.8;

const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v));

/**
 * Two panes side by side with a draggable divider (finger or mouse). The
 * left share is remembered on this screen. The calendar keeps its day
 * width and shows fewer days when it gets narrower.
 */
export function ResizableSplit({ left, right }: { left: ReactNode; right: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [share, setShare] = useState(DEFAULT);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(KEY));
      if (saved) queueMicrotask(() => setShare(clamp(saved)));
    } catch {
      // Storage blocked: keep the default.
    }
  }, []);

  const save = (v: number) => {
    try {
      localStorage.setItem(KEY, String(v));
    } catch {
      // Not remembered; fine.
    }
  };

  const fromPointer = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width === 0) return share;
    return clamp((clientX - r.left) / r.width);
  };

  return (
    <div ref={box} className="flex h-full min-h-0 select-none" style={{ cursor: dragging ? "col-resize" : undefined }}>
      <div className="min-h-0 min-w-0" style={{ flexBasis: `${share * 100}%`, flexGrow: 0, flexShrink: 0 }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag to resize"
        aria-valuemin={MIN * 100}
        aria-valuemax={MAX * 100}
        aria-valuenow={Math.round(share * 100)}
        tabIndex={0}
        className="group flex w-6 shrink-0 cursor-col-resize touch-none items-center justify-center"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (dragging) setShare(fromPointer(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!dragging) return;
          setDragging(false);
          const v = fromPointer(e.clientX);
          setShare(v);
          save(v);
        }}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const v = clamp(share + (e.key === "ArrowLeft" ? -0.05 : 0.05));
          setShare(v);
          save(v);
        }}
      >
        <span className={`h-24 w-1.5 rounded-full transition-colors ${dragging ? "bg-sky-500" : "bg-slate-300 group-hover:bg-slate-400 dark:bg-slate-600"}`} />
      </div>
      <div className="min-h-0 min-w-0 flex-1">{right}</div>
    </div>
  );
}
