"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKioskWatchdog } from "./use-kiosk-watchdog";

/**
 * Kiosk frame: exactly one 100vh screen (no page scroll), live clock,
 * background refresh every 30 s so changes from a phone show up, and night
 * mode. From 9:00 PM to 6:30 AM household time the screen turns dark, and
 * after 3 minutes without a touch it shows a dim drifting clock to avoid
 * burn-in; a tap wakes it. The moon button forces night mode on or off
 * until the next change of period. During the day the layout also shifts by
 * a pixel or two every few minutes.
 *
 * A watchdog (watchdog.ts) reloads the page if fresh renders stop arriving,
 * after the connection comes back, and once a night, without ever looping
 * while offline.
 */
const REFRESH_MS = 30_000;
const IDLE_MS = 3 * 60_000;

function zoned(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return h * 60 + m;
}

export function isNight(now: Date, tz: string): boolean {
  const mins = zoned(now, tz);
  return mins >= 21 * 60 || mins < 6 * 60 + 30;
}

export function KioskShell({ tz, renderedAt, children, header }: { tz: string; renderedAt: number; children: ReactNode; header: ReactNode }) {
  const router = useRouter();
  const { offline } = useKioskWatchdog(renderedAt, tz);
  const [now, setNow] = useState(() => new Date());
  const [override, setOverride] = useState<{ night: boolean; scheduled: boolean } | null>(null);
  const [idle, setIdle] = useState(false);
  const lastTouch = useRef(0);
  // A refresh that cannot reach the server makes Next.js fall back to a full
  // page load (which lands on the offline page), so skip refreshes while
  // offline and let the watchdog reload once the connection is back.
  const offlineRef = useRef(offline);
  useEffect(() => {
    offlineRef.current = offline;
  }, [offline]);

  useEffect(() => {
    lastTouch.current = Date.now();
    const tick = setInterval(() => {
      const d = new Date();
      setNow(d);
      setIdle(Date.now() - lastTouch.current > IDLE_MS);
    }, 15_000);
    const refresh = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine && !offlineRef.current) router.refresh();
    }, REFRESH_MS);
    const wake = () => {
      lastTouch.current = Date.now();
      setIdle(false);
    };
    window.addEventListener("pointerdown", wake, { capture: true });
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
      window.removeEventListener("pointerdown", wake, { capture: true });
    };
  }, [router]);

  const scheduled = isNight(now, tz);
  // A manual override lasts until the schedule itself flips.
  const night = override && override.scheduled === scheduled ? override.night : scheduled;
  const screensaver = night && idle;

  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(now);
  const shift = Math.floor(now.getTime() / 300_000) % 4;

  return (
    <div className={`${night ? "dark" : ""} h-screen w-screen overflow-hidden`}>
      <div
        className="flex h-full w-full flex-col overflow-hidden bg-slate-100 text-slate-900 transition-colors dark:bg-slate-950 dark:text-slate-200"
        style={{ transform: `translate(${shift % 2}px, ${shift >> 1}px)`, filter: night ? "brightness(0.7)" : undefined }}
      >
        <header className="flex h-20 shrink-0 items-center gap-6 px-6">
          <div className="text-5xl font-bold tabular-nums">{time}</div>
          <div className="text-2xl font-medium opacity-80">{date}</div>
          <div className="ml-auto flex items-center gap-3">
            {offline ? (
              <span role="status" className="rounded-full bg-amber-500 px-4 py-2 text-lg font-semibold text-white">
                Offline, reconnecting…
              </span>
            ) : null}
            {header}
            <button
              type="button"
              onClick={() => setOverride({ night: !night, scheduled })}
              className="min-h-12 min-w-12 rounded-xl border text-2xl"
              aria-label={night ? "Day mode" : "Night mode"}
            >
              {night ? "☀️" : "🌙"}
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 px-4 pb-4">{children}</div>
      </div>
      {screensaver ? (
        <div className="fixed inset-0 z-50 bg-black" aria-label="Tap to wake">
          <div
            className="absolute text-center text-slate-500"
            style={{ left: `${10 + ((now.getMinutes() * 7) % 60)}%`, top: `${10 + ((now.getMinutes() * 13) % 60)}%` }}
          >
            <div className="text-7xl font-light tabular-nums">{time}</div>
            <div className="text-xl">{date}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
