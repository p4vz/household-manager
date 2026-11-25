"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { applyUpdate, fetchLatestVersion, isNewer } from "./app-version";

const CHECK_EVERY_MS = 15 * 60 * 1000;

/**
 * One-tap "Update app" bar. Checks for a newer deploy when the app opens,
 * whenever it comes back to the foreground, and every 15 minutes. The
 * kitchen screen is left out: it reloads itself every night.
 */
export function UpdateBanner() {
  const pathname = usePathname();
  const onKiosk = pathname === "/kiosk" || pathname.startsWith("/kiosk/");
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (onKiosk) return;
    let cancelled = false;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void fetchLatestVersion().then((v) => {
        if (!cancelled && isNewer(v)) setLatest(v);
      });
    };
    const first = window.setTimeout(check, 3000);
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [onKiosk]);

  if (onKiosk || !latest || dismissed === latest) return null;

  return (
    <div role="status" className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl bg-slate-900 p-3 text-sm text-white shadow-lg">
      <span className="flex-1">A new version of Household is ready.</span>
      <button type="button" onClick={() => setDismissed(latest)} className="min-h-10 px-2 opacity-70">
        Later
      </button>
      <button
        type="button"
        disabled={updating}
        onClick={() => {
          setUpdating(true);
          void applyUpdate();
        }}
        className="min-h-10 rounded-lg bg-teal-500 px-4 font-medium text-white disabled:opacity-60"
      >
        {updating ? "Updating…" : "Update app"}
      </button>
    </div>
  );
}
