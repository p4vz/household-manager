"use client";

import { useState } from "react";
import { enterFullscreen, rememberKitchenFullscreen } from "@/lib/fullscreen";

/**
 * Turns the device in the member's hand into the kitchen screen: pairs it,
 * signs the member out on it and locks the browser to /kiosk, so kids can't
 * get into the app (enterKitchenModeAction). Leaving needs the adult PIN.
 * Asks first, because it signs this device out.
 */
export function KitchenModeButton({
  className,
  label = "Kitchen mode",
  enter,
}: {
  className?: string;
  label?: string;
  enter: (input: Record<string, never>) => Promise<{ error: string | null }>;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setAsking(true)}>
        🍳 {label}
      </button>
      {asking ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setAsking(false)}>
          <div role="dialog" aria-label="Kitchen mode" className="w-full max-w-md space-y-4 rounded-2xl bg-white p-5 text-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold">Make this the kitchen screen?</h2>
            <p className="text-sm">
              This device becomes the kids-safe kitchen screen and you get signed out on it. It stays on the kitchen screen until an adult taps{" "}
              <b>🔒 Adult</b>, types the adult PIN and taps <b>Exit kitchen mode</b>.
            </p>
            {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                className="min-h-12 flex-1 rounded-xl bg-sky-600 px-4 font-medium text-white disabled:opacity-50"
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  rememberKitchenFullscreen(true);
                  // Ask while still inside the tap.
                  await enterFullscreen().catch(() => undefined);
                  try {
                    const res = await enter({});
                    if (res.error) {
                      setError(res.error);
                      setBusy(false);
                      return;
                    }
                    window.location.assign("/kiosk");
                  } catch {
                    setError("That didn't work. Try again.");
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Switching…" : "Make it the kitchen screen"}
              </button>
              <button type="button" className="min-h-12 rounded-xl border px-4 font-medium" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
