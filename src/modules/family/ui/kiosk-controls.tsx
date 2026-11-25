"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  enterFullscreen,
  exitFullscreen,
  fullscreenSupported,
  isFullscreen,
  rememberKitchenFullscreen,
  wantsKitchenFullscreen,
} from "@/lib/fullscreen";
import { ErrorNote, Modal, tap } from "./kit";

const btn = "min-h-12 min-w-12 rounded-xl border px-3 text-lg font-medium";

export type AdultControls = {
  /** ISO time adult mode ends on this screen, or null when locked. */
  until: string | null;
  unlock: (input: { pin: string }) => Promise<{ ok: true; until: string } | { ok: false; error: string }>;
  lock: (input: Record<string, never>) => Promise<void>;
  exit: (input: Record<string, never>) => Promise<void>;
};

/**
 * Kiosk header controls:
 * - Adult mode: kids use this screen, so deleting events, finishing upkeep,
 *   moving returns along and leaving kitchen mode need the adult PIN. It
 *   lasts five minutes on the server, or until Lock.
 * - Full screen on/off. Browsers drop full screen on every reload (the
 *   watchdog's, or the nightly one) and only allow it again after a tap, so
 *   once it was switched on, the next tap anywhere turns it back on. Leaving
 *   full screen doesn't leave the kitchen screen: the browser stays locked
 *   to /kiosk.
 */
export function KioskControls({ adult }: { adult: AdultControls }) {
  const [full, setFull] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    // Read browser-only state after mount (not available during SSR).
    const sync = () => setFull(isFullscreen());
    queueMicrotask(() => {
      setSupported(fullscreenSupported());
      sync();
    });
    const restore = () => {
      if (wantsKitchenFullscreen() && !isFullscreen()) void enterFullscreen();
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    window.addEventListener("pointerdown", restore, { capture: true });
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      window.removeEventListener("pointerdown", restore, { capture: true });
    };
  }, []);

  return (
    <>
      <AdultMode {...adult} />
      {supported ? (
        <button
          type="button"
          className={btn}
          aria-label={full ? "Leave full screen" : "Full screen"}
          title={full ? "Leave full screen" : "Full screen"}
          onClick={async (e) => {
            // This tap must not also trigger the restore listener's re-entry.
            e.stopPropagation();
            if (isFullscreen()) {
              rememberKitchenFullscreen(false);
              await exitFullscreen();
            } else {
              rememberKitchenFullscreen(true);
              await enterFullscreen();
            }
          }}
        >
          {full ? "🗗" : "⛶"}
        </button>
      ) : null}
    </>
  );
}

function AdultMode({ until, unlock, lock, exit }: AdultControls) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pending, start] = useTransition();
  const end = until ? Date.parse(until) : 0;
  const left = end - now;
  const on = left > 0;

  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      // Ran out: the server already refuses adult actions; show the locked screen.
      if (n >= Date.parse(until)) {
        clearInterval(t);
        router.refresh();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [until, router]);

  if (!on) {
    return (
      <>
        <button type="button" className={btn} onClick={() => setAsking(true)} title="Unlock adult controls with the adult PIN">
          🔒 Adult
        </button>
        {asking ? (
          <PinPad
            title="Adult mode"
            onClose={() => setAsking(false)}
            submit={async (pin) => {
              const res = await unlock({ pin });
              if (!res.ok) return res.error;
              setNow(Date.now());
              setAsking(false);
              router.refresh();
              return null;
            }}
          />
        ) : null}
      </>
    );
  }

  const mins = Math.floor(left / 60_000);
  const secs = Math.floor((left % 60_000) / 1000);
  return (
    <>
      <span className="flex min-h-12 items-center rounded-xl bg-amber-100 px-3 text-lg font-medium text-amber-900">
        🔓 Adult · {mins}:{String(secs).padStart(2, "0")}
      </span>
      <button
        type="button"
        disabled={pending}
        className={`${btn} border-amber-600`}
        onClick={() =>
          start(async () => {
            await lock({});
            router.refresh();
          })
        }
      >
        Lock
      </button>
      <button type="button" className={btn} onClick={() => setLeaving(true)}>
        Exit kitchen mode
      </button>
      {leaving ? (
        <Modal title="Exit kitchen mode?" onClose={() => setLeaving(false)}>
          <p className="mb-4">
            This screen gets unpaired and becomes an ordinary browser again. To use it as the kitchen screen later, tap Kitchen mode in the app or pair it
            with a code from Settings.
          </p>
          <button
            type="button"
            disabled={pending}
            className={`${tap} w-full bg-red-600 text-white disabled:opacity-50`}
            onClick={() =>
              start(async () => {
                await exit({});
                rememberKitchenFullscreen(false);
                await exitFullscreen().catch(() => undefined);
                window.location.assign("/signin");
              })
            }
          >
            Exit kitchen mode
          </button>
        </Modal>
      ) : null}
    </>
  );
}

/** Big digit buttons for a touch screen; the PIN is never shown. */
function PinPad({ title, onClose, submit }: { title: string; onClose: () => void; submit: (pin: string) => Promise<string | null> }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (pin.length < 4 || busy) return;
    setBusy(true);
    try {
      const err = await submit(pin);
      if (err) {
        setError(err);
        setPin("");
      }
    } catch {
      setError("That didn't work. Try again.");
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  const key = "min-h-16 rounded-xl border text-2xl font-semibold active:scale-95 transition-transform select-none";
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-3 opacity-80">Type the adult PIN. Adult controls stay on for 5 minutes.</p>
      <div className="mb-3 flex h-12 items-center justify-center gap-3 text-3xl" aria-label={`${pin.length} digits typed`}>
        {pin.length === 0 ? <span className="text-base opacity-50">PIN</span> : "•".repeat(pin.length)}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" className={key} onClick={() => setPin((p) => (p.length < 8 ? p + d : p))}>
            {d}
          </button>
        ))}
        <button type="button" className={key} aria-label="Delete digit" onClick={() => setPin((p) => p.slice(0, -1))}>
          ⌫
        </button>
        <button type="button" className={key} onClick={() => setPin((p) => (p.length < 8 ? `${p}0` : p))}>
          0
        </button>
        <button type="button" disabled={pin.length < 4 || busy} className={`${key} bg-sky-600 text-white disabled:opacity-50`} onClick={go}>
          {busy ? "…" : "OK"}
        </button>
      </div>
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
