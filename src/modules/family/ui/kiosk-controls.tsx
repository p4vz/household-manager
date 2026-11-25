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

const btn = "min-h-12 min-w-12 rounded-xl border px-3 text-lg font-medium";

/**
 * Kiosk header controls:
 * - Full screen on/off. Browsers drop full screen on every reload (the
 *   watchdog's, or the nightly one) and only allow it again after a tap, so
 *   once it was switched on, the next tap anywhere turns it back on.
 * - For a signed-in parent: "Pair this screen" until the device has its own
 *   kiosk pairing, so the kitchen screen keeps working after signing out of
 *   Google there. There is no "Exit" to the app: kids use this screen.
 */
export function KioskControls({ member, paired, pair }: { member: boolean; paired: boolean; pair: (input: Record<string, never>) => Promise<void> }) {
  const router = useRouter();
  const [full, setFull] = useState(false);
  const [supported, setSupported] = useState(false);
  const [pending, start] = useTransition();
  const [pairedNow, setPairedNow] = useState(false);

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
      {member && !paired && !pairedNow ? (
        <button
          type="button"
          disabled={pending}
          className={`${btn} border-sky-600 text-sky-700`}
          title="Keeps this screen working after you sign out of Google here"
          onClick={() =>
            start(async () => {
              await pair({});
              setPairedNow(true);
              router.refresh();
            })
          }
        >
          {pending ? "Pairing…" : "📌 Pair this screen"}
        </button>
      ) : null}
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
